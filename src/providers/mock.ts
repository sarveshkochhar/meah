import { MeahError, ErrorCodes } from '../errors.ts';
import type { Provider, ProviderRequest, ProviderResult } from './types.ts';

/**
 * Deterministic in-process provider used by tests, `dryRun`, and offline demos.
 * It never performs network I/O and never needs an API key.
 *
 * Behaviour is driven by markers in the task text so tests can exercise every
 * normalized failure path:
 *   [[MOCK:fail:CODE]]   -> throw that MeahError code
 *   [[MOCK:delay:1500]]  -> sleep before responding (for timeout/cancel tests)
 *   [[MOCK:echo]]        -> echo the full prompt back
 */
export type MockProviderOptions = {
  name?: string;
  respond?: (req: ProviderRequest) => string;
};

export function createMockProvider(options: MockProviderOptions = {}): Provider {
  const name = options.name ?? 'mock';
  return {
    name,
    kind: 'mock',
    async complete(req: ProviderRequest): Promise<ProviderResult> {
      const started = Date.now();
      const prompt = `${req.system}\n${req.user}`;

      const delay = /\[\[MOCK:delay:(\d+)\]\]/.exec(prompt);
      if (delay) {
        await new Promise<void>((resolve, reject) => {
          const ms = Number(delay[1]);
          const timer = setTimeout(resolve, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(
              new MeahError(ErrorCodes.CANCELLED, 'Worker was cancelled during the provider call.'),
            );
          };
          if (req.signal.aborted) onAbort();
          else req.signal.addEventListener('abort', onAbort, { once: true });
        });
      }

      const fail = /\[\[MOCK:fail:([A-Z_]+)\]\]/.exec(prompt);
      if (fail) {
        const code = `E_${fail[1]}` as (typeof ErrorCodes)[keyof typeof ErrorCodes];
        throw new MeahError(code, `Mock provider raised ${code}.`, {
          retryable: code === ErrorCodes.RATE_LIMIT || code === ErrorCodes.NETWORK,
        });
      }

      const text = options.respond
        ? options.respond(req)
        : /\[\[MOCK:echo\]\]/.test(prompt)
          ? prompt
          : `MOCK(${req.model}) handled task of ${req.user.length} chars.`;

      return {
        text: text.slice(0, req.maxOutputTokens * 8),
        provider: name,
        model: req.model,
        requestId: `mock-${Math.random().toString(36).slice(2, 10)}`,
        finishReason: 'stop',
        usage: {
          promptTokens: Math.ceil(prompt.length / 4),
          completionTokens: Math.ceil(text.length / 4),
          totalTokens: Math.ceil((prompt.length + text.length) / 4),
        },
        latencyMs: Date.now() - started,
        attempts: 1,
      };
    },
  };
}
