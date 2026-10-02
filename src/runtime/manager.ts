import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MeahError, ErrorCodes, toMeahError, type MeahErrorJson } from '../errors.ts';
import { redact, redactDeep } from '../redact.ts';
import { resolveApiKey, apiKeyEnvNames, type MeahConfig, PERMISSION_PROFILES } from '../config.ts';
import { createOpenAICompatibleProvider } from '../providers/openai-compatible.ts';
import { createMockProvider } from '../providers/mock.ts';
import type { Provider } from '../providers/types.ts';
import { resolveRoute } from '../routing/router.ts';
import { buildPrompt, boundResult, ContextItemSchema } from './context.ts';
import { createWorkspace, type Workspace } from './workspace.ts';
import { resolvePermissions, runCommand, sanitizedEnv, type CommandResult } from './permissions.ts';
import type { Logger } from '../logger.ts';

export const WORKER_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const TERMINAL_STATES: readonly WorkerState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

export const RunRequestSchema = z
  .object({
    task: z.string().min(1).max(20000),
    role: z.string().min(1).max(60).default('researcher'),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    context: z.array(ContextItemSchema).max(50).default([]),
    constraints: z.array(z.string().min(1).max(500)).max(30).default([]),
    expectedOutput: z.string().max(2000).optional(),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
    maxOutputTokens: z.number().int().min(16).max(32768).optional(),
    temperature: z.number().min(0).max(2).optional(),
    permissionProfile: z.enum(PERMISSION_PROFILES).optional(),
    /** Opt-in, allowlisted, workspace-pinned commands whose output joins the context. */
    commands: z.array(z.string().min(1).max(500)).max(20).default([]),
    label: z.string().max(120).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

export type RunRequest = z.input<typeof RunRequestSchema>;

export type WorkerSummary = {
  workerId: string;
  label: string | null;
  state: WorkerState;
  role: string;
  provider: string;
  model: string;
  routeSource: string;
  permissionProfile: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  timeoutMs: number;
  workspace: string | null;
  workspaceRemoved: boolean;
  promptChars: number;
  contextTruncated: boolean;
  /** Denormalized from the result so list views need no second fetch. */
  totalTokens: number | null;
};

export type WorkerRecord = WorkerSummary & {
  result: {
    text: string;
    truncated: boolean;
    finishReason: string;
    requestId: string | null;
    usage: {
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
    };
    latencyMs: number;
    attempts: number;
  } | null;
  error: MeahErrorJson | null;
  commands: CommandResult[];
  droppedContext: string[];
  transcript?: { system: string; user: string } | undefined;
};

type WorkerInternal = {
  record: WorkerRecord;
  controller: AbortController;
  done: Promise<WorkerRecord>;
  workspace: Workspace | null;
};

export type ManagerOptions = {
  config: MeahConfig;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; when absent, providers are built from config. */
  providerFactory?: (name: string) => Provider;
  now?: () => number;
};

/** Small FIFO semaphore enforcing defaults.maxConcurrent. */
function createSemaphore(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    async acquire(): Promise<() => void> {
      if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        const next = queue.shift();
        if (next) next();
      };
    },
  };
}

export class WorkerManager {
  readonly config: MeahConfig;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly workers = new Map<string, WorkerInternal>();
  private readonly semaphore: ReturnType<typeof createSemaphore>;
  private readonly providerFactory: (name: string) => Provider;
  private readonly secrets: string[];

  constructor(options: ManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.env = options.env ?? process.env;
    this.semaphore = createSemaphore(options.config.defaults.maxConcurrent);
    this.secrets = apiKeyEnvNames(options.config)
      .map((name) => this.env[name]?.trim())
      .filter((v): v is string => Boolean(v && v.length >= 4));
    this.providerFactory = options.providerFactory ?? ((name) => this.buildProvider(name));
  }

  private buildProvider(name: string): Provider {
    const cfg = this.config.providers[name];
    if (!cfg) {
      throw new MeahError(ErrorCodes.INVALID_REQUEST, `Unknown provider "${name}".`);
    }
    if (name === 'mock' && this.env.MEAH_ENABLE_MOCK_PROVIDER === 'true') {
      return createMockProvider({ name: 'mock' });
    }
    return createOpenAICompatibleProvider({
      name,
      config: cfg,
      getApiKey: () => resolveApiKey(cfg, this.env),
      maxRetries: this.config.defaults.maxRetries,
      retryBaseMs: this.config.defaults.retryBaseMs,
      secrets: this.secrets,
    });
  }

  stats() {
    const byState: Record<string, number> = {};
    for (const w of this.workers.values())
      byState[w.record.state] = (byState[w.record.state] ?? 0) + 1;
    return {
      total: this.workers.size,
      running: this.semaphore.active,
      queued: this.semaphore.queued,
      maxConcurrent: this.config.defaults.maxConcurrent,
      byState,
    };
  }

  list(): WorkerSummary[] {
    return [...this.workers.values()].map((w) => summarize(w.record));
  }

  get(workerId: string): WorkerRecord {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new MeahError(ErrorCodes.NOT_FOUND, `No worker with id "${workerId}".`, {
        hint: 'Worker state is in-memory and is lost when the MEAH server restarts.',
      });
    }
    // Results are retrievable repeatedly (documented MVP behaviour).
    return worker.record;
  }

  /** Start a worker and return immediately with its queued record. */
  start(rawRequest: RunRequest): WorkerRecord {
    const parsed = RunRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      throw new MeahError(ErrorCodes.INVALID_REQUEST, 'Invalid run request.', {
        details: { issues: parsed.error.issues },
      });
    }
    const req = parsed.data;

    // Reject anything that looks like a credential smuggled in as an argument.
    for (const [field, value] of [
      ['task', req.task],
      ...req.context.map((c) => [`context:${c.name}`, c.text] as const),
    ] as Array<readonly [string, string]>) {
      if (/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/.test(value)) {
        throw new MeahError(
          ErrorCodes.PERMISSION,
          `Field "${field}" appears to contain an API key. MEAH never accepts credentials as tool arguments.`,
          { hint: 'Configure credentials through apiKeyEnv. If a real key was pasted, rotate it.' },
        );
      }
    }

    const route = resolveRoute(this.config, {
      role: req.role,
      provider: req.provider,
      model: req.model,
    });
    const profile = req.permissionProfile ?? this.config.defaults.permissionProfile;
    const permissions = resolvePermissions(profile, this.config);

    if (req.commands.length > 0) {
      if (!permissions.terminal) {
        throw new MeahError(
          ErrorCodes.PERMISSION,
          'Commands were supplied but the permission profile does not allow terminal access.',
          { hint: 'Use permissionProfile "workspace-exec" and enable terminal in the config.' },
        );
      }
      if (req.commands.length > this.config.terminal.maxCommandsPerWorker) {
        throw new MeahError(
          ErrorCodes.PERMISSION,
          `At most ${this.config.terminal.maxCommandsPerWorker} commands per worker are allowed.`,
        );
      }
    }

    const timeoutMs = req.timeoutMs ?? this.config.defaults.timeoutMs;
    const workerId = `w_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const controller = new AbortController();

    const record: WorkerRecord = {
      workerId,
      label: req.label ?? null,
      state: 'queued',
      role: req.role,
      provider: route.provider,
      model: route.model,
      routeSource: route.source,
      permissionProfile: profile,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      timeoutMs,
      workspace: null,
      workspaceRemoved: false,
      promptChars: 0,
      contextTruncated: false,
      totalTokens: null,
      result: null,
      error: null,
      commands: [],
      droppedContext: [],
    };

    const internal: WorkerInternal = {
      record,
      controller,
      workspace: null,
      done: Promise.resolve(record),
    };
    this.workers.set(workerId, internal);

    const log = this.logger.child({
      workerId,
      provider: route.provider,
      model: route.model,
      role: req.role,
    });
    log.info('worker_queued', { label: record.label, permissionProfile: profile, timeoutMs });

    internal.done = this.execute(internal, req, route, permissions, log).catch((err) => {
      // execute() already normalizes; this is a last-resort guard.
      const e = toMeahError(err);
      record.state = record.state === 'cancelled' ? 'cancelled' : 'failed';
      record.error = e.toJSON();
      record.finishedAt ??= new Date().toISOString();
      return record;
    });

    return record;
  }

  /** Start a worker and await its terminal state. */
  async run(rawRequest: RunRequest): Promise<WorkerRecord> {
    const record = this.start(rawRequest);
    return this.wait(record.workerId);
  }

  async wait(workerId: string): Promise<WorkerRecord> {
    const worker = this.workers.get(workerId);
    if (!worker) throw new MeahError(ErrorCodes.NOT_FOUND, `No worker with id "${workerId}".`);
    return worker.done;
  }

  /**
   * Run many workers concurrently; results keep request order.
   *
   * `aggregateTimeoutMs` is enforced HERE rather than by the caller, so that
   * cancellation is scoped to this batch's own workers. Cancelling by scanning
   * the global worker list would kill unrelated in-flight work.
   */
  async runParallel(
    requests: RunRequest[],
    opts: { aggregateTimeoutMs?: number } = {},
  ): Promise<WorkerRecord[]> {
    if (requests.length === 0) {
      throw new MeahError(ErrorCodes.INVALID_REQUEST, 'workers must contain at least one request.');
    }
    // Validation failures for one worker must not abort its siblings.
    const started = requests.map((req) => {
      try {
        return { ok: true as const, id: this.start(req).workerId };
      } catch (err) {
        return { ok: false as const, error: toMeahError(err), req };
      }
    });

    const ownIds = started.filter((s) => s.ok).map((s) => s.id);
    let aggregateTimer: NodeJS.Timeout | undefined;
    if (opts.aggregateTimeoutMs !== undefined) {
      aggregateTimer = setTimeout(() => {
        for (const id of ownIds) {
          const w = this.workers.get(id);
          if (w && !TERMINAL_STATES.includes(w.record.state)) {
            this.cancel(id, 'aggregate timeout exceeded');
          }
        }
      }, opts.aggregateTimeoutMs);
      aggregateTimer.unref?.();
    }

    const settled = await Promise.all(
      started.map(async (s, index) => {
        if (s.ok) return this.wait(s.id);
        const now = new Date().toISOString();
        const failed: WorkerRecord = {
          workerId: `w_rejected_${index}`,
          label: (s.req as { label?: string }).label ?? null,
          state: 'failed',
          role: String((s.req as { role?: string }).role ?? 'unknown'),
          provider: String((s.req as { provider?: string }).provider ?? 'unknown'),
          model: String((s.req as { model?: string }).model ?? 'unknown'),
          routeSource: 'rejected',
          permissionProfile: this.config.defaults.permissionProfile,
          createdAt: now,
          startedAt: null,
          finishedAt: now,
          durationMs: 0,
          timeoutMs: this.config.defaults.timeoutMs,
          workspace: null,
          workspaceRemoved: false,
          promptChars: 0,
          contextTruncated: false,
          totalTokens: null,
          result: null,
          error: s.error.toJSON(),
          commands: [],
          droppedContext: [],
        };
        return failed;
      }),
    );
    if (aggregateTimer) clearTimeout(aggregateTimer);
    return settled;
  }

  cancel(workerId: string, reason = 'cancelled by caller'): WorkerRecord {
    const worker = this.workers.get(workerId);
    if (!worker) throw new MeahError(ErrorCodes.NOT_FOUND, `No worker with id "${workerId}".`);
    if (TERMINAL_STATES.includes(worker.record.state)) return worker.record;
    worker.record.state = 'cancelled';
    worker.record.error = new MeahError(ErrorCodes.CANCELLED, reason).toJSON();
    worker.controller.abort(new MeahError(ErrorCodes.CANCELLED, reason));
    this.logger.info('worker_cancelled', { workerId, reason });
    return worker.record;
  }

  async cleanup(workerId: string): Promise<WorkerRecord> {
    const worker = this.workers.get(workerId);
    if (!worker) throw new MeahError(ErrorCodes.NOT_FOUND, `No worker with id "${workerId}".`);
    if (!TERMINAL_STATES.includes(worker.record.state)) {
      throw new MeahError(
        ErrorCodes.INVALID_REQUEST,
        `Worker "${workerId}" is ${worker.record.state}; cancel it before cleaning up its workspace.`,
      );
    }
    if (worker.workspace && !worker.record.workspaceRemoved) {
      await worker.workspace.remove();
      worker.record.workspaceRemoved = true;
      this.logger.info('workspace_removed', { workerId });
    }
    return worker.record;
  }

  /** Cancel everything and release workspaces; used on server shutdown. */
  async shutdown(): Promise<void> {
    for (const [id, w] of this.workers) {
      if (!TERMINAL_STATES.includes(w.record.state)) this.cancel(id, 'server shutting down');
    }
    await Promise.allSettled([...this.workers.values()].map((w) => w.done));
  }

  private async execute(
    internal: WorkerInternal,
    req: z.infer<typeof RunRequestSchema>,
    route: ReturnType<typeof resolveRoute>,
    permissions: ReturnType<typeof resolvePermissions>,
    log: Logger,
  ): Promise<WorkerRecord> {
    const { record, controller } = internal;
    const release = await this.semaphore.acquire();
    const startedMs = Date.now();

    try {
      if (controller.signal.aborted || record.state === 'cancelled') {
        record.state = 'cancelled';
        record.error ??= new MeahError(ErrorCodes.CANCELLED, 'Cancelled while queued.').toJSON();
        return record;
      }

      record.state = 'running';
      record.startedAt = new Date().toISOString();
      log.info('worker_started', {});

      let workspace: Workspace | null = null;
      if (permissions.materializeContext) {
        workspace = await createWorkspace(this.config.workspaceRoot, record.workerId);
        internal.workspace = workspace;
        record.workspace = workspace.root;
        for (const item of req.context) {
          if (item.kind !== 'file') continue;
          const safeName = item.name.replace(/[^A-Za-z0-9._/-]/g, '_');
          try {
            await workspace.writeFile(`context/${safeName}`, item.text);
          } catch (err) {
            // A bad context path must not silently pass; surface it.
            throw toMeahError(err);
          }
        }
      }

      const commandBlocks: string[] = [];
      if (permissions.terminal && req.commands.length > 0 && workspace) {
        for (const command of req.commands) {
          const result = await runCommand(command, {
            cwd: workspace.root,
            allowlist: this.config.terminal.allowlist,
            timeoutMs: this.config.terminal.timeoutMs,
            maxOutputBytes: this.config.terminal.maxOutputBytes,
            signal: controller.signal,
            env: sanitizedEnv(this.env, workspace.root),
          });
          record.commands.push(result);
          commandBlocks.push(
            `$ ${result.command}\n(exit ${result.exitCode}${result.timedOut ? ', timed out' : ''})\n${redact(
              result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''),
              this.secrets,
            )}`,
          );
          log.info('worker_command', {
            command: result.command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          });
        }
      }

      const contextItems = [...req.context];
      if (commandBlocks.length > 0) {
        contextItems.push({
          name: 'command-output',
          kind: 'text',
          text: commandBlocks.join('\n\n'),
        });
      }

      const prompt = buildPrompt(
        {
          task: req.task,
          role: req.role,
          context: contextItems,
          constraints: req.constraints,
          expectedOutput: req.expectedOutput,
        },
        {
          maxContextChars: this.config.defaults.maxContextChars,
          systemOverride: route.systemOverride,
        },
      );
      record.promptChars = prompt.chars;
      record.contextTruncated = prompt.truncated;
      record.droppedContext = prompt.droppedItems;
      if (this.config.defaults.retainTranscripts) {
        // Retained transcripts are returned through meah_get_agent, so they
        // get the same redaction pass as results and errors.
        record.transcript = {
          system: redact(prompt.system, this.secrets),
          user: redact(prompt.user, this.secrets),
        };
      }

      if (req.dryRun) {
        record.state = 'succeeded';
        record.result = {
          text: `DRY RUN — no provider call was made.\nprovider=${route.provider} model=${route.model} role=${req.role}\nprompt chars=${prompt.chars} truncated=${prompt.truncated}`,
          truncated: false,
          finishReason: 'stop',
          requestId: null,
          usage: { promptTokens: null, completionTokens: null, totalTokens: null },
          latencyMs: 0,
          attempts: 0,
        };
        return record;
      }

      const provider = this.providerFactory(route.provider);
      const completeArgs = {
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: req.maxOutputTokens ?? this.config.defaults.maxOutputTokens,
        temperature: req.temperature ?? route.temperature ?? this.config.defaults.temperature,
        timeoutMs: record.timeoutMs,
        signal: controller.signal,
      };

      let raw;
      try {
        raw = await provider.complete({ model: route.model, ...completeArgs });
      } catch (primaryErr) {
        const primaryMeahErr = toMeahError(primaryErr);
        if (
          !route.fallbackModel ||
          primaryMeahErr.code === ErrorCodes.CANCELLED ||
          controller.signal.aborted
        ) {
          throw primaryMeahErr;
        }
        log.warn('worker_fallback_model', {
          primaryModel: route.model,
          fallbackModel: route.fallbackModel,
          reason: primaryMeahErr.code,
        });
        try {
          raw = await provider.complete({ model: route.fallbackModel, ...completeArgs });
          route.model = route.fallbackModel;
        } catch (fallbackErr) {
          // Report the primary failure — the fallback attempt is a bonus try,
          // not the request the caller actually cares about diagnosing.
          throw primaryMeahErr;
        }
      }

      // A provider whose response was already in flight can resolve just after
      // a cancel. Honour the cancellation instead of flipping the record to
      // "succeeded" while an E_CANCELLED error is still attached to it.
      // (cast: cancel() mutates state from outside this async flow, which
      // control-flow narrowing cannot see)
      if (controller.signal.aborted || (record.state as WorkerState) === 'cancelled') {
        throw new MeahError(
          ErrorCodes.CANCELLED,
          'Worker was cancelled before its result could be recorded.',
        );
      }

      const bounded = boundResult(
        redact(raw.text, this.secrets),
        this.config.defaults.maxResultChars,
      );
      record.error = null;
      record.result = {
        text: bounded.text,
        truncated: bounded.truncated,
        finishReason: raw.finishReason,
        requestId: raw.requestId,
        usage: raw.usage,
        latencyMs: raw.latencyMs,
        attempts: raw.attempts,
      };
      record.model = raw.model;
      record.totalTokens = raw.usage.totalTokens;
      record.state = 'succeeded';

      if (permissions.writeWorkspace && workspace) {
        await workspace.writeFile('result.md', bounded.text);
      }

      log.info('worker_succeeded', {
        latencyMs: raw.latencyMs,
        attempts: raw.attempts,
        finishReason: raw.finishReason,
        usage: raw.usage,
      });
      return record;
    } catch (err) {
      const e = toMeahError(err);
      if (e.code === ErrorCodes.CANCELLED || controller.signal.aborted) {
        record.state = record.state === 'timed_out' ? 'timed_out' : 'cancelled';
      } else if (e.code === ErrorCodes.TIMEOUT) {
        record.state = 'timed_out';
      } else {
        record.state = 'failed';
      }
      // Redact the WHOLE error payload, not just the message: `details` can
      // carry a provider response body, and this is the last point before it
      // reaches the caller.
      record.result = null;
      record.error = redactDeep(e.toJSON(), this.secrets) as MeahErrorJson;
      log.warn('worker_failed', {
        state: record.state,
        code: e.code,
        message: record.error.message,
      });
      return record;
    } finally {
      record.finishedAt = new Date().toISOString();
      record.durationMs = Date.now() - startedMs;
      release();
      if (
        this.config.defaults.cleanupWorkspaceOnFinish &&
        internal.workspace &&
        !record.workspaceRemoved
      ) {
        try {
          await internal.workspace.remove();
          record.workspaceRemoved = true;
        } catch (err) {
          this.logger.warn('workspace_cleanup_failed', {
            workerId: record.workerId,
            reason: String(err),
          });
        }
      }
    }
  }
}

export function summarize(record: WorkerRecord): WorkerSummary {
  const {
    result: _r,
    error: _e,
    commands: _c,
    transcript: _t,
    droppedContext: _d,
    ...summary
  } = record;
  return summary;
}
