/**
 * Manual MCP smoke test.
 *
 * Spawns `src/server.ts` as a real child process over stdio, speaks MCP to it,
 * and exercises the whole tool surface. By default it uses the built-in mock
 * provider, so it needs no API key and makes no network calls.
 *
 *   node --experimental-strip-types scripts/smoke.ts
 *
 * To smoke-test a live provider instead (this DOES spend tokens):
 *
 *   MEAH_SMOKE_PROVIDER=glm MEAH_GLM_API_KEY=... node --experimental-strip-types scripts/smoke.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const live = process.env.MEAH_SMOKE_PROVIDER;

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
function record(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!live) {
    env.MEAH_ENABLE_MOCK_PROVIDER = 'true';
    env.MEAH_ROLE_RESEARCHER_PROVIDER = 'mock';
    env.MEAH_ROLE_CODER_PROVIDER = 'mock';
    env.MEAH_ROLE_REVIEWER_PROVIDER = 'mock';
    env.MEAH_ROLE_SUMMARIZER_PROVIDER = 'mock';
  }
  env.MEAH_LOG_LEVEL = env.MEAH_LOG_LEVEL ?? 'warn';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', path.join(repoRoot, 'src', 'server.ts')],
    cwd: repoRoot,
    env,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'meah-smoke', version: '0.1.0' });
  await client.connect(transport);
  record('connect over stdio', true, 'MCP handshake completed');

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    // Live reasoning models can take minutes; raise the client-side timeout.
    const res = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 300_000,
    })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(res.content[0]!.text) as { ok: boolean; data?: any; error?: any };
  };

  const { tools } = await client.listTools();
  record('list tools', tools.length === 8, tools.map((t) => t.name).join(', '));

  const models = await call('meah_list_models');
  const providerNames = (models.data?.providers ?? []).map((p: { provider: string }) => p.provider);
  record('meah_list_models', models.ok, `providers: ${providerNames.join(', ') || 'none'}`);
  const serialized = JSON.stringify(models.data);
  record(
    'no secrets in list_models output',
    !/\bsk-[A-Za-z0-9_-]{12,}/.test(serialized),
    'output scanned for key-shaped strings',
  );

  const provider = live ?? 'mock';
  // Reasoning models can spend a small budget entirely on reasoning tokens.
  const tokenBudget = live ? 2048 : 64;
  const task = live
    ? 'Reply with exactly: MEAH LIVE SMOKE OK'
    : 'Describe what MEAH does in one sentence.';

  const single = await call('meah_delegate_task', {
    task,
    role: 'summarizer',
    provider,
    maxOutputTokens: tokenBudget,
    // Block long enough for a live model; the default stays under the MCP
    // client timeout on purpose.
    ...(live ? { waitMs: 280_000 } : {}),
  });
  record(
    'single worker succeeds',
    single.ok && single.data.state === 'succeeded',
    single.ok
      ? `${single.data.state}, ${single.data.result?.text?.slice(0, 60)?.replace(/\s+/g, ' ')}`
      : JSON.stringify(single.error),
  );

  const parallel = await call('meah_parallel_agents', {
    workers: [
      {
        task: 'Name one benefit of isolated workers.',
        role: 'researcher',
        provider,
        maxOutputTokens: tokenBudget,
        label: 'a',
      },
      {
        task: 'Name one risk of isolated workers.',
        role: 'reviewer',
        provider,
        maxOutputTokens: tokenBudget,
        label: 'b',
      },
    ],
  });
  record(
    'parallel workers',
    parallel.ok && parallel.data.summary.total === 2,
    JSON.stringify(parallel.data?.summary),
  );

  const bad = await call('meah_delegate_task', { task: 'hello', provider: 'no-such-provider' });
  record(
    'unknown provider error',
    !bad.ok && bad.error.code === 'E_INVALID_REQUEST',
    bad.error?.code,
  );

  const smuggled = await call('meah_delegate_task', { task: 'key is sk-abcdefghijklmnopqrstuvwx' });
  record(
    'credential-in-argument rejected',
    !smuggled.ok && smuggled.error.code === 'E_PERMISSION',
    smuggled.error?.code,
  );

  const traversal = await call('meah_delegate_task', {
    task: 'read it',
    provider,
    dryRun: true,
    context: [{ name: '../../../etc/passwd', kind: 'file', text: 'x' }],
  });
  record(
    'path traversal in context name rejected',
    !traversal.ok || traversal.data.state === 'failed',
    traversal.ok ? traversal.data.error?.code : traversal.error?.code,
  );

  // The mock provider returns instantly, so hold it open long enough to cancel.
  const slowTask = live
    ? 'Write a long, detailed essay about cache invalidation strategies.'
    : 'Write a long essay about caching. [[MOCK:delay:5000]]';
  const started = await call('meah_run_agent', { task: slowTask, provider, role: 'researcher' });
  const cancelled = await call('meah_cancel_agent', {
    workerId: started.data.workerId,
    cleanupWorkspace: true,
  });
  record(
    'cancel + workspace cleanup',
    cancelled.ok && cancelled.data.state === 'cancelled' && cancelled.data.workspaceRemoved,
    `${cancelled.data?.state}, workspaceRemoved=${cancelled.data?.workspaceRemoved}`,
  );

  await client.close();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} smoke checks passed (provider: ${provider}${live ? ', LIVE' : ', mock'})`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
