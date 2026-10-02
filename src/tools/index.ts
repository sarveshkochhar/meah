import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toMeahError } from '../errors.ts';
import { describeProviders } from '../config.ts';
import { describeRoutes } from '../routing/router.ts';
import { WorkerManager, summarize, type WorkerRecord } from '../runtime/manager.ts';
import {
  RunAgentInput,
  DelegateTaskInput,
  ParallelAgentsInput,
  GetAgentInput,
  CancelAgentInput,
  ListAgentsInput,
  ListModelsInput,
  WorkerIdInput,
} from './schemas.ts';

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

function json(value: unknown, isError = false): ToolResponse {
  const out: ToolResponse = {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
  if (isError) out.isError = true;
  return out;
}

/** Every handler returns a normalized envelope, never a raw throw. */
async function guard(fn: () => Promise<unknown> | unknown): Promise<ToolResponse> {
  try {
    return json({ ok: true, data: await fn() });
  } catch (err) {
    return json({ ok: false, error: toMeahError(err).toJSON() }, true);
  }
}

function publicRecord(record: WorkerRecord, includeTranscript: boolean) {
  const { transcript, ...rest } = record;
  return includeTranscript && transcript ? { ...rest, transcript } : rest;
}

export function registerTools(server: McpServer, manager: WorkerManager): void {
  server.registerTool(
    'meah_list_models',
    {
      title: 'List MEAH external models',
      description:
        'List locally configured external providers, their models, role routing defaults, and runtime limits. Never returns API keys.',
      inputSchema: ListModelsInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(() => ({
        providers: describeProviders(manager.config, process.env),
        roles: describeRoutes(manager.config),
        defaults: manager.config.defaults,
        terminal: {
          enabled: manager.config.terminal.enabled,
          allowlist: manager.config.terminal.allowlist,
        },
        runtime: manager.stats(),
        note: 'MEAH workers are external models. They are separate from, and do not replace, Claude native subagents.',
      })),
  );

  server.registerTool(
    'meah_run_agent',
    {
      title: 'Start an external worker (async)',
      description:
        'Start one isolated external worker and return immediately with its workerId. Poll meah_get_agent for the result. Supply only the context the worker needs.',
      inputSchema: RunAgentInput.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => guard(() => summarize(manager.start(args))),
  );

  server.registerTool(
    'meah_delegate_task',
    {
      title: 'Delegate a task to an external worker (blocking)',
      description:
        'Run one isolated external worker and wait for its result. Routes by role unless provider/model are given. Returns normalized text, usage, and errors.',
      inputSchema: DelegateTaskInput.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { waitMs, ...runArgs } = args;
        const record = manager.start(runArgs);
        // MCP clients (Claude Desktop included) enforce their own per-request
        // timeout, typically 60s. Blocking past it makes the CALL fail even
        // though the worker is fine, so we hand back the id before that and
        // let the caller poll. The worker keeps running either way.
        const budget = waitMs ?? Math.min(record.timeoutMs + 5000, 50_000);
        const settled = await Promise.race([
          manager.wait(record.workerId),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), budget).unref?.()),
        ]);
        if (settled) return publicRecord(settled, false);
        return {
          ...summarize(manager.get(record.workerId)),
          note: 'Still running after waitMs. Poll meah_get_agent with this workerId, or cancel it.',
        };
      }),
  );

  server.registerTool(
    'meah_parallel_agents',
    {
      title: 'Run several external workers in parallel',
      description:
        'Run up to 16 isolated workers concurrently (bounded by defaults.maxConcurrent) and return all results in request order. Partial failures are reported per worker.',
      inputSchema: ParallelAgentsInput.shape,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        // The manager owns the aggregate timeout so cancellation stays scoped
        // to this batch. Cancelling by scanning every worker would kill
        // unrelated work started by other calls.
        const records: WorkerRecord[] = await manager.runParallel(
          args.workers,
          args.aggregateTimeoutMs === undefined
            ? {}
            : { aggregateTimeoutMs: args.aggregateTimeoutMs },
        );
        return {
          workers: records.map((r) => publicRecord(r, false)),
          summary: {
            total: records.length,
            succeeded: records.filter((r) => r.state === 'succeeded').length,
            failed: records.filter((r) => r.state === 'failed').length,
            cancelled: records.filter((r) => r.state === 'cancelled').length,
            timedOut: records.filter((r) => r.state === 'timed_out').length,
          },
        };
      }),
  );

  server.registerTool(
    'meah_get_agent',
    {
      title: 'Inspect an external worker',
      description:
        'Get the current state, timestamps, and (when finished) the result or normalized error for a worker. Results can be read repeatedly.',
      inputSchema: GetAgentInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(() => publicRecord(manager.get(args.workerId), args.includeTranscript)),
  );

  server.registerTool(
    'meah_list_agents',
    {
      title: 'List external workers',
      description:
        'List every worker known to this MEAH process, optionally filtered by lifecycle state.',
      inputSchema: ListAgentsInput.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(() => {
        const all = manager.list();
        return {
          workers: args.state ? all.filter((w) => w.state === args.state) : all,
          runtime: manager.stats(),
        };
      }),
  );

  server.registerTool(
    'meah_cancel_agent',
    {
      title: 'Cancel an external worker',
      description:
        'Abort a queued or running worker: the provider request and any child process are aborted and the worker moves to state "cancelled". Optionally removes its workspace.',
      inputSchema: CancelAgentInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const record = manager.cancel(args.workerId, args.reason ?? 'cancelled by caller');
        if (args.cleanupWorkspace) {
          await manager.wait(args.workerId).catch(() => undefined);
          await manager.cleanup(args.workerId);
        }
        return summarize(manager.get(record.workerId));
      }),
  );

  server.registerTool(
    'meah_cleanup_workspace',
    {
      title: 'Remove a finished worker workspace',
      description:
        'Delete the isolated workspace directory of a finished worker. The worker record itself is kept.',
      inputSchema: WorkerIdInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => summarize(await manager.cleanup(args.workerId))),
  );
}

export const TOOL_NAMES = [
  'meah_list_models',
  'meah_run_agent',
  'meah_delegate_task',
  'meah_parallel_agents',
  'meah_get_agent',
  'meah_list_agents',
  'meah_cancel_agent',
  'meah_cleanup_workspace',
] as const;
