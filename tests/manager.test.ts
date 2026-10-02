import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorkerManager, TERMINAL_STATES } from '../src/runtime/manager.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import { MeahError } from '../src/errors.ts';
import type { Provider } from '../src/providers/types.ts';
import { testConfig, managerWithMock, silentLogger } from './helpers.ts';

const baseTask = { task: 'Explain the repository layout.', role: 'researcher' as const };

describe('worker lifecycle', () => {
  test('single worker succeeds with full metadata', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({ ...baseTask, label: 'layout' });

    assert.equal(record.state, 'succeeded');
    assert.match(record.workerId, /^w_[a-f0-9]{20}$/);
    assert.equal(record.label, 'layout');
    assert.equal(record.provider, 'testp');
    assert.equal(record.model, 'test-model');
    assert.ok(record.result);
    assert.match(record.result.text, /MOCK\(test-model\)/);
    assert.ok(record.createdAt && record.startedAt && record.finishedAt);
    assert.ok(record.durationMs !== null && record.durationMs >= 0);
    assert.equal(record.error, null);
  });

  test('results are retrievable repeatedly', async () => {
    const manager = managerWithMock(await testConfig());
    const { workerId } = await manager.run(baseTask);
    assert.equal(manager.get(workerId).state, 'succeeded');
    assert.equal(manager.get(workerId).state, 'succeeded');
    assert.equal(manager.get(workerId).result!.text, manager.get(workerId).result!.text);
  });

  test('unknown worker id yields E_NOT_FOUND', async () => {
    const manager = managerWithMock(await testConfig());
    assert.throws(
      () => manager.get('w_nope'),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_NOT_FOUND');
        return true;
      },
    );
  });

  test('state transitions queued -> running -> succeeded', async () => {
    const manager = managerWithMock(await testConfig());
    const started = manager.start({ ...baseTask, task: 'wait [[MOCK:delay:80]]' });
    assert.equal(started.state, 'queued');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(manager.get(started.workerId).state, 'running');
    const done = await manager.wait(started.workerId);
    assert.equal(done.state, 'succeeded');
    assert.ok(TERMINAL_STATES.includes(done.state));
  });

  test('dryRun never calls the provider', async () => {
    let called = false;
    const spy: Provider = {
      name: 'testp',
      kind: 'mock',
      complete: async () => {
        called = true;
        throw new Error('should not be called');
      },
    };
    const manager = managerWithMock(await testConfig(), spy);
    const record = await manager.run({ ...baseTask, dryRun: true });
    assert.equal(called, false);
    assert.equal(record.state, 'succeeded');
    assert.match(record.result!.text, /DRY RUN/);
  });

  test('provider failures normalize onto the record without throwing', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({ ...baseTask, task: 'boom [[MOCK:fail:AUTH]]' });
    assert.equal(record.state, 'failed');
    assert.equal(record.error!.code, 'E_AUTH');
    assert.equal(record.result, null);
  });

  test('timeout produces state timed_out', async () => {
    const manager = managerWithMock(await testConfig(), {
      name: 'testp',
      kind: 'mock',
      complete: async () => {
        throw new MeahError('E_TIMEOUT', 'Provider did not respond within 1000ms.');
      },
    });
    const record = await manager.run({ ...baseTask, timeoutMs: 1000 });
    assert.equal(record.state, 'timed_out');
    assert.equal(record.error!.code, 'E_TIMEOUT');
  });

  test('cancellation aborts a running worker', async () => {
    const manager = managerWithMock(await testConfig());
    const started = manager.start({ ...baseTask, task: 'slow [[MOCK:delay:5000]]' });
    await new Promise((r) => setTimeout(r, 30));
    manager.cancel(started.workerId, 'user changed their mind');
    const record = await manager.wait(started.workerId);
    assert.equal(record.state, 'cancelled');
    assert.equal(record.error!.code, 'E_CANCELLED');
    assert.ok(record.durationMs! < 5000, 'must not wait for the provider');
  });

  test('cancelling a queued worker never starts it', async () => {
    const config = await testConfig();
    const manager = managerWithMock({
      ...config,
      defaults: { ...config.defaults, maxConcurrent: 1 },
    });
    const blocker = manager.start({ ...baseTask, task: 'block [[MOCK:delay:200]]' });
    const queued = manager.start({ ...baseTask, task: 'second' });
    assert.equal(manager.get(queued.workerId).state, 'queued');
    manager.cancel(queued.workerId);
    const [b, q] = await Promise.all([
      manager.wait(blocker.workerId),
      manager.wait(queued.workerId),
    ]);
    assert.equal(b.state, 'succeeded');
    assert.equal(q.state, 'cancelled');
    assert.equal(q.result, null);
  });

  test('cancelling a finished worker is a no-op', async () => {
    const manager = managerWithMock(await testConfig());
    const done = await manager.run(baseTask);
    assert.equal(manager.cancel(done.workerId).state, 'succeeded');
  });

  test('credentials smuggled in as tool arguments are rejected', async () => {
    const manager = managerWithMock(await testConfig());
    assert.throws(
      () => manager.start({ ...baseTask, task: 'use key sk-abcdefghijklmnopqrstuvwx please' }),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_PERMISSION');
        assert.match(err.message, /never accepts credentials as tool arguments/);
        return true;
      },
    );
  });

  test('retained transcripts are redacted before they can be read back', async () => {
    const SECRET = 'live-secret-abcdefghijklmnop';
    const config = await testConfig();
    const retaining = {
      ...config,
      defaults: { ...config.defaults, retainTranscripts: true },
    };
    const manager = new WorkerManager({
      config: retaining,
      logger: silentLogger(),
      env: { MEAH_TEST_API_KEY: SECRET } as NodeJS.ProcessEnv,
      providerFactory: () => createMockProvider({ name: 'testp' }),
    });
    const record = await manager.run({
      ...baseTask,
      context: [{ name: 'leaky.txt', kind: 'text', text: `the key is ${SECRET}` }],
    });
    assert.ok(record.transcript, 'transcript should be retained');
    const serialized = JSON.stringify(record.transcript);
    assert.ok(!serialized.includes(SECRET), 'transcript must not echo a configured key');
    assert.match(serialized, /REDACTED/);
  });

  test('a cancel racing a completing provider keeps the worker cancelled', async () => {
    // Regression: the record used to end up state=succeeded while still
    // carrying an E_CANCELLED error, i.e. both a result and an error.
    const config = await testConfig();
    let resolveProvider!: (value: unknown) => void;
    const manager = new WorkerManager({
      config,
      logger: silentLogger(),
      env: {} as NodeJS.ProcessEnv,
      providerFactory: () => ({
        name: 'testp',
        kind: 'mock',
        // Ignores the abort signal, like a response already in flight.
        complete: () =>
          new Promise((resolve) => {
            resolveProvider = resolve as (value: unknown) => void;
          }) as never,
      }),
    });
    const started = manager.start(baseTask);
    await new Promise((r) => setTimeout(r, 30));
    manager.cancel(started.workerId, 'user cancelled');
    resolveProvider({
      text: 'late answer',
      provider: 'testp',
      model: 'm',
      requestId: null,
      finishReason: 'stop',
      usage: { promptTokens: null, completionTokens: null, totalTokens: null },
      latencyMs: 1,
      attempts: 1,
    });
    const record = await manager.wait(started.workerId);
    assert.equal(record.state, 'cancelled');
    assert.equal(record.result, null, 'a cancelled worker must not carry a result');
    assert.equal(record.error!.code, 'E_CANCELLED');
  });

  test('secrets are redacted from error details, not just the message', async () => {
    // Regression: error.details could carry a raw provider body with a key.
    const SECRET = 'live-secret-abcdefghijklmnop';
    const config = await testConfig();
    const manager = new WorkerManager({
      config,
      logger: silentLogger(),
      env: { MEAH_TEST_API_KEY: SECRET } as NodeJS.ProcessEnv,
      providerFactory: () => ({
        name: 'testp',
        kind: 'mock',
        complete: async () => {
          throw new MeahError('E_PROVIDER', `upstream rejected ${SECRET}`, {
            details: { body: `{"error":"key ${SECRET} rejected"}` },
          });
        },
      }),
    });
    const record = await manager.run(baseTask);
    const serialized = JSON.stringify(record.error);
    assert.ok(!serialized.includes(SECRET), serialized);
    assert.match(serialized, /REDACTED/);
  });

  test('provider output is redacted and bounded', async () => {
    const config = await testConfig();
    const bounded = { ...config, defaults: { ...config.defaults, maxResultChars: 200 } };
    const manager = new WorkerManager({
      config: bounded,
      logger: silentLogger(),
      env: { MEAH_TEST_API_KEY: 'live-key-abcdefghijklmno' } as NodeJS.ProcessEnv,
      providerFactory: () =>
        createMockProvider({
          name: 'testp',
          respond: () => `leak live-key-abcdefghijklmno ${'z'.repeat(1000)}`,
        }),
    });
    const record = await manager.run(baseTask);
    assert.ok(!record.result!.text.includes('live-key-abcdefghijklmno'));
    assert.equal(record.result!.truncated, true);
    assert.ok(record.result!.text.length < 400);
  });
});

describe('workspaces and permissions', () => {
  test('read-only default materializes context but writes no result', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({
      ...baseTask,
      context: [{ name: 'notes.md', kind: 'file', text: 'hello' }],
    });
    assert.ok(record.workspace);
    assert.equal(
      await fs.readFile(path.join(record.workspace!, 'context', 'notes.md'), 'utf8'),
      'hello',
    );
    assert.equal(
      await fs.access(path.join(record.workspace!, 'result.md')).then(
        () => true,
        () => false,
      ),
      false,
      'read-only must not write a result file',
    );
  });

  test('workspace-write persists the result inside the workspace only', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({ ...baseTask, permissionProfile: 'workspace-write' });
    const written = await fs.readFile(path.join(record.workspace!, 'result.md'), 'utf8');
    assert.equal(written, record.result!.text);
  });

  test('each worker gets its own workspace', async () => {
    const manager = managerWithMock(await testConfig());
    const [a, b] = await Promise.all([manager.run(baseTask), manager.run(baseTask)]);
    assert.notEqual(a.workspace, b.workspace);
  });

  test('profile "none" creates no workspace', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({ ...baseTask, permissionProfile: 'none' });
    assert.equal(record.workspace, null);
  });

  test('a context filename that tries to traverse fails the worker, and nothing escapes', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({
      ...baseTask,
      context: [{ name: '../../escape.txt', kind: 'file', text: 'x' }],
    });
    assert.equal(record.state, 'failed');
    assert.equal(record.error!.code, 'E_PATH_ESCAPE');
    const parent = await fs.readdir(path.dirname(record.workspace!));
    assert.ok(!parent.includes('escape.txt'));
    assert.equal(
      await fs.access(path.join(record.workspace!, '..', '..', 'escape.txt')).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  test('odd but contained context filenames are sanitized and kept inside', async () => {
    const manager = managerWithMock(await testConfig());
    const record = await manager.run({
      ...baseTask,
      context: [{ name: 'weird name$;.md', kind: 'file', text: 'ok' }],
    });
    assert.equal(record.state, 'succeeded');
    assert.deepEqual(await fs.readdir(path.join(record.workspace!, 'context')), [
      'weird_name__.md',
    ]);
  });

  test('commands require workspace-exec and an enabled terminal', async () => {
    const manager = managerWithMock(await testConfig());
    assert.throws(
      () => manager.start({ ...baseTask, commands: ['node -v'] }),
      /does not allow terminal access/,
    );
    assert.throws(
      () =>
        manager.start({ ...baseTask, commands: ['node -v'], permissionProfile: 'workspace-exec' }),
      /requires terminal.enabled/,
    );
  });

  test('allowlisted commands feed their output into the prompt', async () => {
    const config = await testConfig();
    const withTerminal = {
      ...config,
      terminal: { ...config.terminal, enabled: true, allowlist: ['node'] },
    };
    const manager = new WorkerManager({
      config: withTerminal,
      logger: silentLogger(),
      env: {} as NodeJS.ProcessEnv,
      providerFactory: () => createMockProvider({ name: 'testp', respond: (req) => req.user }),
    });
    const record = await manager.run({
      ...baseTask,
      permissionProfile: 'workspace-exec',
      commands: ['node -p 6*7'],
    });
    assert.equal(record.state, 'succeeded');
    assert.equal(record.commands.length, 1);
    assert.equal(record.commands[0]!.exitCode, 0);
    assert.match(record.result!.text, /command-output/);
    assert.match(record.result!.text, /42/);
  });

  test('cleanup removes the workspace and refuses while still running', async () => {
    const manager = managerWithMock(await testConfig());
    const running = manager.start({ ...baseTask, task: 'slow [[MOCK:delay:300]]' });
    await assert.rejects(manager.cleanup(running.workerId), /cancel it before cleaning up/);
    const done = await manager.wait(running.workerId);
    const cleaned = await manager.cleanup(done.workerId);
    assert.equal(cleaned.workspaceRemoved, true);
    assert.equal(
      await fs.access(done.workspace!).then(
        () => true,
        () => false,
      ),
      false,
    );
    // The record itself survives cleanup.
    assert.equal(manager.get(done.workerId).state, 'succeeded');
  });
});

describe('parallel execution', () => {
  test('runs workers in parallel and preserves request order', async () => {
    const manager = managerWithMock(await testConfig());
    const records = await manager.runParallel([
      { task: 'first [[MOCK:delay:60]]', role: 'researcher', label: 'a' },
      { task: 'second', role: 'summarizer', label: 'b' },
      { task: 'third [[MOCK:delay:30]]', role: 'reviewer', label: 'c' },
    ]);
    assert.deepEqual(
      records.map((r) => r.label),
      ['a', 'b', 'c'],
    );
    assert.ok(records.every((r) => r.state === 'succeeded'));
    assert.equal(new Set(records.map((r) => r.workerId)).size, 3);
  });

  test('partial failure returns both the successes and the normalized errors', async () => {
    const manager = managerWithMock(await testConfig());
    const records = await manager.runParallel([
      { task: 'ok one', role: 'researcher' },
      { task: 'bad [[MOCK:fail:RATE_LIMIT]]', role: 'researcher' },
      { task: 'bad [[MOCK:fail:MALFORMED_RESPONSE]]', role: 'researcher' },
      { task: 'ok two', role: 'researcher' },
    ]);
    assert.deepEqual(
      records.map((r) => r.state),
      ['succeeded', 'failed', 'failed', 'succeeded'],
    );
    assert.equal(records[1]!.error!.code, 'E_RATE_LIMIT');
    assert.equal(records[2]!.error!.code, 'E_MALFORMED_RESPONSE');
    assert.ok(records[3]!.result);
  });

  test('an invalid sibling request does not abort the batch', async () => {
    const manager = managerWithMock(await testConfig());
    const records = await manager.runParallel([
      { task: 'fine', role: 'researcher' },
      { task: 'bad route', role: 'researcher', provider: 'does-not-exist' },
    ]);
    assert.equal(records[0]!.state, 'succeeded');
    assert.equal(records[1]!.state, 'failed');
    assert.equal(records[1]!.error!.code, 'E_INVALID_REQUEST');
  });

  test('maxConcurrent is enforced', async () => {
    const config = await testConfig();
    const limited = { ...config, defaults: { ...config.defaults, maxConcurrent: 2 } };
    let active = 0;
    let peak = 0;
    const manager = new WorkerManager({
      config: limited,
      logger: silentLogger(),
      env: {} as NodeJS.ProcessEnv,
      providerFactory: () => ({
        name: 'testp',
        kind: 'mock',
        complete: async (req) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 40));
          active--;
          return {
            text: 'ok',
            provider: 'testp',
            model: req.model,
            requestId: null,
            finishReason: 'stop' as const,
            usage: { promptTokens: null, completionTokens: null, totalTokens: null },
            latencyMs: 40,
            attempts: 1,
          };
        },
      }),
    });
    const records = await manager.runParallel(
      Array.from({ length: 6 }, (_, i) => ({ task: `task ${i}`, role: 'researcher' })),
    );
    assert.equal(records.filter((r) => r.state === 'succeeded').length, 6);
    assert.ok(peak <= 2, `peak concurrency was ${peak}`);
  });

  test('aggregate timeout cancels only its own batch, never bystanders', async () => {
    // Regression: the aggregate timeout used to scan every worker in the
    // process and cancel unrelated in-flight work.
    const manager = managerWithMock(await testConfig());
    const bystander = manager.start({ ...baseTask, task: 'unrelated [[MOCK:delay:400]]' });
    const records = await manager.runParallel(
      [{ task: 'batch [[MOCK:delay:5000]]', role: 'researcher' }],
      {
        aggregateTimeoutMs: 100,
      },
    );
    assert.equal(records[0]!.state, 'cancelled');
    assert.equal((await manager.wait(bystander.workerId)).state, 'succeeded');
  });

  test('a batch that finishes in time is untouched by the aggregate timeout', async () => {
    const manager = managerWithMock(await testConfig());
    const records = await manager.runParallel(
      [
        { task: 'quick one', role: 'researcher' },
        { task: 'quick two', role: 'researcher' },
      ],
      { aggregateTimeoutMs: 5000 },
    );
    assert.deepEqual(
      records.map((r) => r.state),
      ['succeeded', 'succeeded'],
    );
  });

  test('shutdown cancels everything still in flight', async () => {
    const manager = managerWithMock(await testConfig());
    const a = manager.start({ ...baseTask, task: 'slow [[MOCK:delay:5000]]' });
    const b = manager.start({ ...baseTask, task: 'slow [[MOCK:delay:5000]]' });
    await new Promise((r) => setTimeout(r, 20));
    await manager.shutdown();
    assert.equal(manager.get(a.workerId).state, 'cancelled');
    assert.equal(manager.get(b.workerId).state, 'cancelled');
  });
});

describe('fallback model', () => {
  test('retries once on the fallback model when the primary model fails', async () => {
    const config = await testConfig({
      roles: { researcher: { provider: 'testp', model: 'flaky-model', fallbackModel: 'safe-model' } },
    });
    const provider = createMockProvider({
      name: 'testp',
      respond: (req) => {
        if (req.model === 'flaky-model') throw new MeahError('E_PROVIDER', 'primary is down');
        return `handled by ${req.model}`;
      },
    });
    const manager = managerWithMock(config, provider);
    const record = await manager.run(baseTask);

    assert.equal(record.state, 'succeeded');
    assert.equal(record.model, 'safe-model');
    assert.match(record.result!.text, /handled by safe-model/);
  });

  test('reports the primary error when the fallback also fails', async () => {
    const config = await testConfig({
      roles: { researcher: { provider: 'testp', model: 'flaky-model', fallbackModel: 'also-flaky' } },
    });
    const provider = createMockProvider({
      name: 'testp',
      respond: (req) => {
        throw new MeahError('E_PROVIDER', `${req.model} is down`);
      },
    });
    const manager = managerWithMock(config, provider);
    const record = await manager.run(baseTask);

    assert.equal(record.state, 'failed');
    assert.equal(record.error!.code, 'E_PROVIDER');
    assert.match(record.error!.message, /flaky-model is down/);
  });

  test('an explicit model request is never substituted with the fallback', async () => {
    const config = await testConfig({
      roles: { researcher: { provider: 'testp', model: 'flaky-model', fallbackModel: 'safe-model' } },
    });
    const provider = createMockProvider({
      name: 'testp',
      respond: (req) => {
        if (req.model === 'flaky-model') throw new MeahError('E_PROVIDER', 'primary is down');
        return `handled by ${req.model}`;
      },
    });
    const manager = managerWithMock(config, provider);
    const record = await manager.run({ ...baseTask, model: 'flaky-model' });

    assert.equal(record.state, 'failed');
    assert.equal(record.error!.code, 'E_PROVIDER');
  });
});
