import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, TOOL_NAMES } from '../src/tools/index.ts';
import { WorkerManager } from '../src/runtime/manager.ts';
import { testConfig, managerWithMock } from './helpers.ts';

type Envelope = { ok: boolean; data?: any; error?: { code: string; message: string } };

let client: Client;
let server: McpServer;
let manager: WorkerManager;

async function call(name: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Envelope;
}

describe('MCP tool surface (in-memory client <-> server)', () => {
  before(async () => {
    manager = managerWithMock(await testConfig());
    server = new McpServer({ name: 'meah-test', version: '0.0.0' });
    registerTools(server, manager);
    client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await manager.shutdown();
    await client.close();
    await server.close();
  });

  test('advertises every tool with a validated input schema', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.ok(
        tool.description && tool.description.length > 20,
        `${tool.name} needs a description`,
      );
      assert.equal(tool.inputSchema.type, 'object');
      const serialized = JSON.stringify(tool.inputSchema);
      // The schema must not offer any way to inject credentials or endpoints.
      for (const forbidden of ['apiKey', 'api_key', 'baseUrl', 'authorization', 'headers']) {
        assert.ok(!serialized.includes(forbidden), `${tool.name} must not accept ${forbidden}`);
      }
    }
  });

  test('meah_list_models returns providers and routing without secrets', async () => {
    const res = await call('meah_list_models');
    assert.equal(res.ok, true);
    assert.equal(res.data.providers[0].provider, 'testp');
    assert.equal(res.data.providers[0].apiKeyEnv, 'MEAH_TEST_API_KEY');
    assert.ok(!JSON.stringify(res.data).includes('test-key-value-123456'));
    assert.equal(res.data.roles.length, 6);
    assert.match(res.data.note, /do not replace/i);
  });

  test('meah_delegate_task runs a worker end to end', async () => {
    const res = await call('meah_delegate_task', { task: 'Summarize this.', role: 'summarizer' });
    assert.equal(res.ok, true);
    assert.equal(res.data.state, 'succeeded');
    assert.match(res.data.result.text, /MOCK/);
    assert.ok(res.data.workerId);
  });

  test('meah_run_agent + meah_get_agent + meah_cleanup_workspace', async () => {
    const started = await call('meah_run_agent', {
      task: 'slow [[MOCK:delay:120]]',
      role: 'coder',
    });
    assert.equal(started.data.state, 'queued');
    const id = started.data.workerId as string;

    const listed = await call('meah_list_agents', { state: 'running' });
    assert.equal(listed.ok, true);

    let record = await call('meah_get_agent', { workerId: id });
    while (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(record.data.state)) {
      await new Promise((r) => setTimeout(r, 25));
      record = await call('meah_get_agent', { workerId: id });
    }
    assert.equal(record.data.state, 'succeeded');
    assert.equal(record.data.transcript, undefined, 'transcripts are off by default');

    const cleaned = await call('meah_cleanup_workspace', { workerId: id });
    assert.equal(cleaned.data.workspaceRemoved, true);
  });

  test('meah_cancel_agent stops a running worker', async () => {
    const started = await call('meah_run_agent', {
      task: 'slow [[MOCK:delay:5000]]',
      role: 'coder',
    });
    const cancelled = await call('meah_cancel_agent', {
      workerId: started.data.workerId,
      reason: 'no longer needed',
      cleanupWorkspace: true,
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.data.state, 'cancelled');
    assert.equal(cancelled.data.workspaceRemoved, true);
  });

  test('meah_parallel_agents reports partial failure per worker', async () => {
    const res = await call('meah_parallel_agents', {
      workers: [
        { task: 'one', role: 'researcher', label: 'a' },
        { task: 'two [[MOCK:fail:RATE_LIMIT]]', role: 'researcher', label: 'b' },
        { task: 'three', role: 'researcher', label: 'c' },
      ],
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.data.summary, {
      total: 3,
      succeeded: 2,
      failed: 1,
      cancelled: 0,
      timedOut: 0,
    });
    assert.deepEqual(
      res.data.workers.map((w: { label: string }) => w.label),
      ['a', 'b', 'c'],
    );
    assert.equal(res.data.workers[1].error.code, 'E_RATE_LIMIT');
  });

  test('errors come back as a normalized envelope, not a protocol failure', async () => {
    const missing = await call('meah_get_agent', { workerId: 'w_does_not_exist' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error!.code, 'E_NOT_FOUND');

    const badProvider = await call('meah_delegate_task', { task: 'x', provider: 'nope' });
    assert.equal(badProvider.ok, false);
    assert.equal(badProvider.error!.code, 'E_INVALID_REQUEST');

    const smuggled = await call('meah_delegate_task', {
      task: 'here is sk-abcdefghijklmnopqrstuvwx',
    });
    assert.equal(smuggled.ok, false);
    assert.equal(smuggled.error!.code, 'E_PERMISSION');
  });

  test('schema violations are rejected before any worker starts', async () => {
    const before = (await call('meah_list_agents')).data.workers.length;
    for (const args of [
      { task: '' }, // below min length
      { task: 'x', timeoutMs: 99 }, // below min timeout
      { task: 'x', permissionProfile: 'root' }, // not an allowed profile
      { task: 'x', temperature: 9 }, // out of range
    ]) {
      const res = (await client.callTool({ name: 'meah_delegate_task', arguments: args })) as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      assert.equal(res.isError, true, `expected rejection for ${JSON.stringify(args)}`);
      assert.match(res.content[0]!.text, /invalid|validation|expected/i);
    }
    assert.equal(
      (await call('meah_list_agents')).data.workers.length,
      before,
      'no workers were created',
    );
  });

  test('dryRun works with no provider call and no key', async () => {
    const res = await call('meah_delegate_task', { task: 'plan it', role: 'coder', dryRun: true });
    assert.equal(res.data.state, 'succeeded');
    assert.match(res.data.result.text, /DRY RUN/);
  });
});

describe('console ownership', () => {
  test('a yieldable console hands the port over; a pool-owning one refuses', async (t) => {
    const { createControlPlane, startControlPlane } = await import('../src/web/control-plane.ts');
    const { testConfig, managerWithMock, silentLogger } = await import('./helpers.ts');
    const config = await testConfig();
    const port = 7930 + Math.floor(Math.random() * 40);
    const mgr = managerWithMock(config);

    // Standalone console: agrees to stand aside.
    const standalone = await startControlPlane({
      manager: mgr,
      config,
      logger: silentLogger(),
      port,
      yieldable: true,
    });
    const yielded = await fetch(`http://127.0.0.1:${port}/api/handover`, { method: 'POST' });
    assert.equal(yielded.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    standalone.close();

    // Pool-owning console: refuses to be displaced.
    const owner = createControlPlane({ manager: mgr, config, logger: silentLogger(), port });
    await new Promise<void>((resolve) => owner.listen(port, '127.0.0.1', resolve));
    const refused = await fetch(`http://127.0.0.1:${port}/api/handover`, { method: 'POST' });
    assert.equal(refused.status, 409);
    const body = (await refused.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'E_PERMISSION');
    owner.close();
    await mgr.shutdown();
  });
});
