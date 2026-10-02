import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MeahError, ErrorCodes } from '../errors.ts';

/**
 * Per-worker isolated directories plus the path-containment checks that keep a
 * worker from touching anything outside its own workspace.
 */

const DEVICE_PATH = /^(?:\\\\[.?]\\|\\\\)|^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const POSIX_DEVICE = /^\/(?:dev|proc|sys)(?:\/|$)/i;

export type Workspace = {
  workerId: string;
  root: string;
  /** Absolute path under the workspace, or a MeahError if the path escapes. */
  resolve(relative: string): string;
  writeFile(relative: string, contents: string): Promise<string>;
  readFile(relative: string): Promise<string>;
  remove(): Promise<void>;
};

/** Pure containment check: no filesystem access, so it is safe for validation. */
export function assertContainedPath(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new MeahError(ErrorCodes.INVALID_REQUEST, 'Path must be a non-empty string.');
  }
  if (relative.includes('\0')) {
    throw new MeahError(ErrorCodes.PATH_ESCAPE, 'Path contains a NUL byte.');
  }
  if (DEVICE_PATH.test(relative) || POSIX_DEVICE.test(relative)) {
    throw new MeahError(ErrorCodes.PATH_ESCAPE, `Refusing device or special path: ${relative}`);
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new MeahError(ErrorCodes.PATH_ESCAPE, `Absolute paths are not allowed: ${relative}`, {
      hint: 'Supply a path relative to the worker workspace.',
    });
  }
  const normalizedRoot = path.resolve(root);
  const candidate = path.resolve(normalizedRoot, relative);
  const rel = path.relative(normalizedRoot, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new MeahError(ErrorCodes.PATH_ESCAPE, `Path escapes the worker workspace: ${relative}`);
  }
  return candidate;
}

/**
 * Containment check that additionally resolves symlinks. Any existing component
 * that resolves outside the workspace is rejected.
 */
export async function assertContainedRealPath(root: string, relative: string): Promise<string> {
  const candidate = assertContainedPath(root, relative);
  const realRoot = await fs.realpath(root);

  let probe = candidate;
  const unresolved: string[] = [];
  // Walk upward to the first component that actually exists.
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const rel = path.relative(realRoot, real);
      if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new MeahError(
          ErrorCodes.PATH_ESCAPE,
          `Path resolves outside the worker workspace (symlink or junction): ${relative}`,
        );
      }
      return path.join(real, ...unresolved.reverse());
    } catch (err) {
      if (err instanceof MeahError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new MeahError(ErrorCodes.PATH_ESCAPE, `Cannot resolve path safely: ${relative}`);
      }
      unresolved.push(path.basename(probe));
      probe = parent;
    }
  }
}

export async function ensureWorkspaceRoot(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  return fs.realpath(root);
}

export async function createWorkspace(rootDir: string, workerId: string): Promise<Workspace> {
  if (!/^[A-Za-z0-9_-]+$/.test(workerId)) {
    throw new MeahError(ErrorCodes.INVALID_REQUEST, `Unsafe worker id: ${workerId}`);
  }
  const realRoot = await ensureWorkspaceRoot(rootDir);
  const root = path.join(realRoot, workerId);
  await fs.mkdir(root, { recursive: true });

  return {
    workerId,
    root,
    resolve: (relative) => assertContainedPath(root, relative),
    async writeFile(relative, contents) {
      const target = await assertContainedRealPath(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents, 'utf8');
      return target;
    },
    async readFile(relative) {
      const target = await assertContainedRealPath(root, relative);
      return fs.readFile(target, 'utf8');
    },
    async remove() {
      // Guard against ever rm -rf'ing something outside the configured root.
      const rel = path.relative(realRoot, root);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new MeahError(
          ErrorCodes.PATH_ESCAPE,
          'Refusing to remove a directory outside the workspace root.',
        );
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
