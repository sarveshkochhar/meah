import { spawn } from 'node:child_process';
import { MeahError, ErrorCodes } from '../errors.ts';
import type { PermissionProfile, MeahConfig } from '../config.ts';

/**
 * Permission profiles, from most to least restrictive:
 *   none            - no filesystem materialization at all
 *   read-only       - supplied context is materialized read-only (default)
 *   workspace-write - the worker result is written into its workspace
 *   workspace-exec  - additionally allows allowlisted commands in the workspace
 */
export type Permissions = {
  profile: PermissionProfile;
  materializeContext: boolean;
  writeWorkspace: boolean;
  terminal: boolean;
};

export function resolvePermissions(profile: PermissionProfile, config: MeahConfig): Permissions {
  const terminal = profile === 'workspace-exec';
  if (terminal && !config.terminal.enabled) {
    throw new MeahError(
      ErrorCodes.PERMISSION,
      'Permission profile "workspace-exec" requires terminal.enabled=true in the MEAH config.',
      {
        hint: 'Set "terminal": { "enabled": true, "allowlist": [...] } or MEAH_TERMINAL_ENABLED=true.',
      },
    );
  }
  return {
    profile,
    materializeContext: profile !== 'none',
    writeWorkspace: profile === 'workspace-write' || profile === 'workspace-exec',
    terminal,
  };
}

export type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  timedOut: boolean;
};

/**
 * Environment handed to a worker subprocess. Every MEAH_* variable and anything
 * that looks like a credential is stripped, so provider keys can never leak into
 * a command the worker influenced.
 */
export function sanitizedEnv(env: NodeJS.ProcessEnv, workspaceRoot: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'SystemRoot', 'windir', 'COMSPEC', 'TEMP', 'TMP', 'LANG', 'TZ'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = env[key];
    if (value) out[key] = value;
  }
  out.HOME = workspaceRoot;
  out.USERPROFILE = workspaceRoot;
  out.MEAH_WORKER = '1';
  return out;
}

function splitCommand(command: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((p) => p.replace(/^["']|["']$/g, ''));
}

const SHELL_METACHARACTERS = /[;&|><`$(){}\n\r]/;

/**
 * Run one allowlisted command pinned to the worker workspace. No shell is used,
 * so metacharacters cannot chain commands; they are rejected outright anyway.
 */
export async function runCommand(
  command: string,
  opts: {
    cwd: string;
    allowlist: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  if (SHELL_METACHARACTERS.test(command)) {
    throw new MeahError(
      ErrorCodes.PERMISSION,
      'Shell metacharacters are not allowed in worker commands.',
      {
        details: { command },
      },
    );
  }
  const argv = splitCommand(command);
  const bin = argv[0];
  if (!bin) throw new MeahError(ErrorCodes.INVALID_REQUEST, 'Empty command.');
  if (!opts.allowlist.includes(bin)) {
    throw new MeahError(
      ErrorCodes.PERMISSION,
      `Command "${bin}" is not in the terminal allowlist.`,
      {
        hint: `Allowed: ${opts.allowlist.join(', ')}`,
      },
    );
  }

  const started = Date.now();
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(bin, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? sanitizedEnv(process.env, opts.cwd),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const cap = (current: string, chunk: Buffer): string => {
      if (current.length >= opts.maxOutputBytes) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > opts.maxOutputBytes) {
        truncated = true;
        return next.slice(0, opts.maxOutputBytes);
      }
      return next;
    };

    child.stdout.on('data', (c: Buffer) => {
      stdout = cap(stdout, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = cap(stderr, c);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const onAbort = () => child.kill('SIGKILL');
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      reject(
        new MeahError(ErrorCodes.PERMISSION, `Failed to start "${bin}": ${err.message}`, {
          cause: err,
        }),
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
      resolve({
        command,
        exitCode: code,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}
