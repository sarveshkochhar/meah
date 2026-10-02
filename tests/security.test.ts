import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  assertContainedPath,
  assertContainedRealPath,
  createWorkspace,
} from '../src/runtime/workspace.ts';
import { redact, redactDeep } from '../src/redact.ts';
import { runCommand, sanitizedEnv, resolvePermissions } from '../src/runtime/permissions.ts';
import { createLogger } from '../src/logger.ts';
import { MeahError } from '../src/errors.ts';
import { tempDir, testConfig } from './helpers.ts';

describe('path containment', () => {
  const root = path.resolve('/srv/meah/workspaces/w_1');

  test('accepts ordinary relative paths', () => {
    assert.equal(assertContainedPath(root, 'notes.md'), path.join(root, 'notes.md'));
    assert.equal(assertContainedPath(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
    assert.equal(assertContainedPath(root, './a/../b.txt'), path.join(root, 'b.txt'));
  });

  test('rejects traversal, absolute paths, device paths, and NUL bytes', () => {
    const bad = [
      '../escape.txt',
      '../../etc/passwd',
      'a/../../../outside.txt',
      '/etc/passwd',
      'C:/Windows/System32/config',
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\x',
      '\\\\.\\PhysicalDrive0',
      '/dev/null',
      '/proc/self/environ',
      'NUL',
      'evil\0.txt',
      '.',
    ];
    for (const p of bad) {
      assert.throws(
        () => assertContainedPath(root, p),
        (err: unknown) => {
          assert.ok(err instanceof MeahError, `${p} should raise MeahError`);
          assert.ok(
            ['E_PATH_ESCAPE', 'E_INVALID_REQUEST'].includes(err.code),
            `${p} -> ${err.code}`,
          );
          return true;
        },
        `expected rejection for ${p}`,
      );
    }
  });

  test('rejects a symlink that points outside the workspace', async (t) => {
    const base = await tempDir();
    const ws = path.join(base, 'ws');
    const outside = path.join(base, 'outside');
    await fs.mkdir(ws, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret');

    try {
      await fs.symlink(outside, path.join(ws, 'link'), 'junction');
    } catch {
      t.skip('symlink/junction creation not permitted in this environment');
      return;
    }

    // Plain lexical containment passes; realpath containment must catch it.
    assert.doesNotThrow(() => assertContainedPath(ws, 'link/secret.txt'));
    await assert.rejects(
      assertContainedRealPath(ws, 'link/secret.txt'),
      (err: unknown) => err instanceof MeahError && err.code === 'E_PATH_ESCAPE',
    );
  });

  test('workspace write/read stay inside, escapes are rejected', async () => {
    const root = await tempDir();
    const ws = await createWorkspace(root, 'w_abc123');
    const written = await ws.writeFile('context/a.txt', 'hello');
    assert.ok(written.startsWith(ws.root));
    assert.equal(await ws.readFile('context/a.txt'), 'hello');
    await assert.rejects(ws.writeFile('../pwned.txt', 'x'), /escapes the worker workspace/);
    await ws.remove();
    assert.equal(
      await fs.access(ws.root).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  test('workspace ids are validated', async () => {
    const root = await tempDir();
    await assert.rejects(createWorkspace(root, '../evil'), /Unsafe worker id/);
  });
});

describe('secret redaction', () => {
  test('removes literal secrets and key-shaped strings', () => {
    const secret = 'abcd1234efgh5678ijkl';
    const text = `key=${secret} and sk-ABCDEFGHIJKLMNOPQRSTU and Authorization: Bearer zzzzzzzzzzzzzzzz`;
    const out = redact(text, [secret]);
    assert.ok(!out.includes(secret));
    assert.ok(!out.includes('sk-ABCDEFGHIJKLMNOPQRSTU'));
    assert.ok(!out.includes('zzzzzzzzzzzzzzzz'));
    assert.match(out, /\[REDACTED\]/);
  });

  test('redactDeep drops sensitive keys at any depth', () => {
    const out = redactDeep(
      {
        a: { authorization: 'Bearer xyz', nested: { api_key: 'k', note: 'sk-AAAAAAAAAAAAAAAAAA' } },
      },
      [],
    ) as Record<string, Record<string, unknown>>;
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes('Bearer xyz'));
    assert.ok(!serialized.includes('sk-AAAAAAAAAAAAAAAAAA'));
  });

  test('logger redacts configured secrets from every payload', () => {
    const lines: string[] = [];
    const log = createLogger('debug', ['live-secret-value-1234'], {}, (l) => lines.push(l));
    log.info('event', { detail: 'token is live-secret-value-1234', authorization: 'Bearer abc' });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes('live-secret-value-1234'));
    assert.ok(!lines[0]!.includes('Bearer abc'));
  });
});

describe('terminal permissions', () => {
  test('workspace-exec requires terminal.enabled', async () => {
    const config = await testConfig();
    assert.throws(() => resolvePermissions('workspace-exec', config), /requires terminal.enabled/);
    const enabled = { ...config, terminal: { ...config.terminal, enabled: true } };
    assert.equal(resolvePermissions('workspace-exec', enabled).terminal, true);
    assert.equal(resolvePermissions('read-only', enabled).terminal, false);
    assert.equal(resolvePermissions('read-only', enabled).writeWorkspace, false);
  });

  test('rejects non-allowlisted commands and shell metacharacters', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    const opts = {
      cwd,
      allowlist: ['node'],
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    };
    await assert.rejects(runCommand('rm -rf /', opts), /not in the terminal allowlist/);
    await assert.rejects(runCommand('node -e 1 && rm -rf /', opts), /Shell metacharacters/);
    await assert.rejects(runCommand('node -e 1 | curl evil', opts), /Shell metacharacters/);
    await assert.rejects(runCommand('node -e `whoami`', opts), /Shell metacharacters/);
  });

  test('runs an allowlisted command pinned to the workspace with a sanitized env', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    const result = await runCommand(
      'node -p process.env.MEAH_GLM_API_KEY+","+process.env.MEAH_WORKER',
      {
        cwd,
        allowlist: ['node'],
        timeoutMs: 15000,
        maxOutputBytes: 4096,
        signal: controller.signal,
        env: sanitizedEnv({ ...process.env, MEAH_GLM_API_KEY: 'must-not-leak' }, cwd),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(
      !result.stdout.includes('must-not-leak'),
      'provider keys must not reach subprocesses',
    );
    assert.match(result.stdout, /undefined,1/);
  });

  test('caps command output', async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    await fs.writeFile(path.join(cwd, 'noisy.js'), 'process.stdout.write("x".repeat(50000));\n');
    const result = await runCommand('node noisy.js', {
      cwd,
      allowlist: ['node'],
      timeoutMs: 15000,
      maxOutputBytes: 512,
      signal: controller.signal,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 512);
  });
});
