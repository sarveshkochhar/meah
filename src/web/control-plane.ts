import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toMeahError } from '../errors.ts';
import {
  describeProviders,
  resolveApiKey,
  ROLES,
  RoleRouteSchema,
  type MeahConfig,
  type Role,
} from '../config.ts';
import { MeahError, ErrorCodes } from '../errors.ts';
import { describeRoutes } from '../routing/router.ts';
import { WorkerManager, summarize, RunRequestSchema } from '../runtime/manager.ts';
import { assertContainedPath } from '../runtime/workspace.ts';
import type { Logger } from '../logger.ts';

/**
 * Local HTTP control plane for the MEAH web console.
 *
 * It shares the WorkerManager with the MCP server when started from
 * `src/server.ts`, so the console shows exactly the workers Claude spawned.
 *
 * Security posture: loopback bind only, plus Host and Origin checks. Those
 * checks matter — without them any web page open in the browser could POST to
 * localhost and spend the user's tokens (CSRF / DNS-rebinding). No CORS
 * headers are ever emitted, so cross-origin reads are refused by the browser.
 */

const WEB_ROOT = path.resolve(fileURLToPath(new URL('../../web', import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return LOOPBACK.has(addr);
}

function hostAllowed(req: http.IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const [name] = host.split(':');
  const declaredPort = host.includes(':') ? Number(host.split(':').pop()) : 80;
  return (name === 'localhost' || name === '127.0.0.1') && declaredPort === port;
}

function originAllowed(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and curl send none
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // The console loads only its own same-origin assets.
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The console posts a subset of the MCP tool schema. */
export const CreateWorkerBody = RunRequestSchema.partial({ role: true }).extend({
  role: z.string().min(1).max(60).default('researcher'),
});

/** Body for changing which model a role routes to, from the console. */
export const UpdateRoleBody = RoleRouteSchema.partial().strict();

/** Provider model catalogs are fetched once and cached for the process. */
const catalogCache = new Map<string, { ids: string[]; at: number }>();
const CATALOG_TTL_MS = 5 * 60 * 1000;

async function fetchModelCatalog(
  config: MeahConfig,
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const provider = config.providers[name];
  if (!provider) throw new MeahError(ErrorCodes.NOT_FOUND, `Unknown provider "${name}".`);

  const cached = catalogCache.get(name);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.ids;

  // A configured catalog is authoritative; don't call the network for it.
  if (provider.models.length > 0) {
    catalogCache.set(name, { ids: provider.models, at: Date.now() });
    return provider.models;
  }

  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${resolveApiKey(provider, env)}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new MeahError(
      ErrorCodes.PROVIDER,
      `Provider "${name}" did not return a model list (HTTP ${res.status}).`,
      { hint: 'Set a models list in config to populate the picker without a network call.' },
    );
  }
  const json = (await res.json()) as { data?: Array<{ id?: string; mode?: string }> };
  const ids = (json.data ?? [])
    .filter((m) => typeof m.id === 'string' && (m.mode === undefined || m.mode === 'chat'))
    .map((m) => m.id as string)
    .sort();
  catalogCache.set(name, { ids, at: Date.now() });
  return ids;
}

export type ControlPlaneOptions = {
  manager: WorkerManager;
  config: MeahConfig;
  logger: Logger;
  port: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Console ownership. Only one process can serve the port, and the useful one
   * is whichever holds the worker pool Claude is actually using.
   *
   * - `yieldable`: this console will step aside when a Claude-hosted MEAH asks
   *   for the port (set by the standalone `npm start` launcher).
   * - `preempt`: on a port clash, ask the incumbent to step aside first (set by
   *   the MCP server, which owns Claude's pool).
   */
  yieldable?: boolean;
  preempt?: boolean;
  /** Called after this console has handed the port over. */
  onYield?: () => void;
};

export function createControlPlane(options: ControlPlaneOptions): http.Server {
  const { manager, config, logger, port } = options;
  const env = options.env ?? process.env;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      const e = toMeahError(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.toJSON() });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isLoopback(req)) {
      res.writeHead(403).end('MEAH console accepts loopback connections only.');
      return;
    }
    if (!hostAllowed(req, port) || !originAllowed(req, port)) {
      // Blocks DNS-rebinding and cross-site requests from other pages.
      res.writeHead(403).end('Rejected Host or Origin.');
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const { pathname } = url;
    const method = req.method ?? 'GET';

    if (pathname.startsWith('/api/')) return api(req, res, method, pathname);
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405).end('Method not allowed.');
      return;
    }
    return serveStatic(res, pathname);
  }

  async function api(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    pathname: string,
  ): Promise<void> {
    try {
      if (method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, {
          ok: true,
          data: {
            providers: describeProviders(config, env),
            roles: describeRoutes(config),
            defaults: config.defaults,
            terminal: { enabled: config.terminal.enabled, allowlist: config.terminal.allowlist },
            workspaceRoot: config.workspaceRoot,
            configPath: config.sourcePath,
            runtime: manager.stats(),
            workers: manager.list(),
          },
        });
      }

      if (method === 'POST' && pathname === '/api/handover') {
        if (!options.yieldable) {
          return sendJson(res, 409, {
            ok: false,
            error: {
              code: 'E_PERMISSION',
              message: 'This console owns the worker pool and will not hand over the port.',
              retryable: false,
            },
          });
        }
        logger.info('console_handover', { reason: 'a Claude-hosted MEAH claimed the port' });
        sendJson(res, 200, { ok: true, data: { yielded: true } });
        // Close after the response is flushed so the caller sees the 200.
        setTimeout(() => {
          server.close();
          options.onYield?.();
        }, 50);
        return;
      }

      if (method === 'POST' && pathname === '/api/workers') {
        const body = await readJsonBody(req);
        const parsed = CreateWorkerBody.safeParse(body);
        if (!parsed.success) {
          return sendJson(res, 400, {
            ok: false,
            error: {
              code: 'E_INVALID_REQUEST',
              message: 'Invalid worker request.',
              retryable: false,
              details: { issues: parsed.error.issues },
            },
          });
        }
        const record = manager.start(parsed.data);
        logger.info('console_worker_started', { workerId: record.workerId });
        return sendJson(res, 202, { ok: true, data: summarize(record) });
      }

      const catalog = /^\/api\/providers\/([a-z0-9_-]+)\/models$/.exec(pathname);
      if (method === 'GET' && catalog) {
        return sendJson(res, 200, {
          ok: true,
          data: { models: await fetchModelCatalog(config, catalog[1]!, env) },
        });
      }

      const role = /^\/api\/roles\/([a-z]+)$/.exec(pathname);
      if (method === 'PUT' && role) {
        const roleName = role[1] as Role;
        if (!(ROLES as readonly string[]).includes(roleName)) {
          throw new MeahError(ErrorCodes.INVALID_REQUEST, `Unknown role "${roleName}".`, {
            hint: `Roles: ${ROLES.join(', ')}`,
          });
        }
        const parsed = UpdateRoleBody.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          throw new MeahError(ErrorCodes.INVALID_REQUEST, 'Invalid role update.', {
            details: { issues: parsed.error.issues },
          });
        }
        const existing = config.roles[roleName];
        const provider = parsed.data.provider ?? existing?.provider;
        if (!provider) {
          throw new MeahError(ErrorCodes.INVALID_REQUEST, `Role "${roleName}" needs a provider.`);
        }
        if (!config.providers[provider]) {
          throw new MeahError(ErrorCodes.INVALID_REQUEST, `Unknown provider "${provider}".`, {
            hint: `Configured providers: ${Object.keys(config.providers).join(', ')}`,
          });
        }
        // Applies immediately: resolveRoute reads config.roles on every call.
        // In-memory only, so a restart returns to .env / meah.config.json.
        config.roles[roleName] = { ...existing, ...parsed.data, provider };
        logger.info('console_role_updated', {
          role: roleName,
          provider,
          model: config.roles[roleName]?.model ?? null,
        });
        return sendJson(res, 200, { ok: true, data: { roles: describeRoutes(config) } });
      }

      const detail = /^\/api\/workers\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (method === 'GET' && detail) {
        return sendJson(res, 200, { ok: true, data: manager.get(detail[1]!) });
      }

      const cancel = /^\/api\/workers\/([A-Za-z0-9_]+)\/cancel$/.exec(pathname);
      if (method === 'POST' && cancel) {
        const record = manager.cancel(cancel[1]!, 'cancelled from the MEAH console');
        return sendJson(res, 200, { ok: true, data: summarize(record) });
      }

      const cleanup = /^\/api\/workers\/([A-Za-z0-9_]+)\/workspace$/.exec(pathname);
      if (method === 'DELETE' && cleanup) {
        const record = await manager.cleanup(cleanup[1]!);
        return sendJson(res, 200, { ok: true, data: summarize(record) });
      }

      return sendJson(res, 404, {
        ok: false,
        error: { code: 'E_NOT_FOUND', message: `No route ${method} ${pathname}`, retryable: false },
      });
    } catch (err) {
      const e = toMeahError(err);
      const status =
        e.code === 'E_NOT_FOUND'
          ? 404
          : e.code === 'E_PERMISSION'
            ? 403
            : e.code === 'E_CONFIG'
              ? 500
              : 400;
      return sendJson(res, status, { ok: false, error: e.toJSON() });
    }
  }

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    let filePath: string;
    try {
      // Same containment rules as worker workspaces: no traversal out of web/.
      filePath = assertContainedPath(WEB_ROOT, relative);
    } catch {
      res.writeHead(400).end('Bad path.');
      return;
    }
    try {
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
      });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found.');
    }
  }

  return server;
}

/** Ask whoever holds the port to step aside. Resolves true if they agreed. */
async function requestHandover(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/handover`, {
      method: 'POST',
      headers: { host: `127.0.0.1:${port}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    // Nothing listening, or not a MEAH console. Either way, do not preempt.
    return false;
  }
}

function listenOnce(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: unknown) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // Loopback only. Never bind 0.0.0.0: this API can spend the user's tokens.
    server.listen(port, '127.0.0.1');
  });
}

export async function startControlPlane(options: ControlPlaneOptions): Promise<http.Server> {
  const server = createControlPlane(options);
  const { port, logger } = options;

  try {
    await listenOnce(server, port);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw err;

    // Someone already has the port. If we own Claude's worker pool, our console
    // is the one worth showing, so ask the incumbent to stand down.
    if (options.preempt && (await requestHandover(port))) {
      logger.info('console_preempted', { port, of: 'a standalone MEAH console' });
      // Give the listener a moment to actually release the socket.
      for (let attempt = 1; attempt <= 10; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          await listenOnce(server, port);
          logger.info('console_listening', { url: `http://127.0.0.1:${port}` });
          return server;
        } catch (retryErr) {
          if ((retryErr as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw retryErr;
        }
      }
    }

    throw new MeahError(ErrorCodes.CONFIG, `Port ${port} is already in use.`, {
      hint: `Another MEAH console is running and did not hand over. Stop it, or set MEAH_WEB_PORT to a free port.`,
      cause: err,
    });
  }

  logger.info('console_listening', { url: `http://127.0.0.1:${port}` });
  return server;
}
