import { z } from 'zod';
import { MeahError, ErrorCodes } from '../errors.ts';
import { redact } from '../redact.ts';
import type { Provider, ProviderRequest, ProviderResult } from './types.ts';
import type { ProviderConfig } from '../config.ts';

/**
 * Adapter for any OpenAI-compatible `/chat/completions` endpoint.
 * Z.AI GLM and https://aicredits.in/v1 are both reached through configuration
 * only — there is no provider-specific branch anywhere in this file.
 */

const ChoiceSchema = z.object({
  index: z.number().optional(),
  finish_reason: z.string().nullish(),
  message: z
    .object({
      role: z.string().optional(),
      // Some GLM-style endpoints return an array of content parts.
      content: z
        .union([
          z.string(),
          z.array(z.object({ type: z.string().optional(), text: z.string().optional() })),
          z.null(),
        ])
        .optional(),
      // Reasoning models expose their scratchpad under one of these names.
      // It is never the answer, so it is never used as the result text.
      reasoning_content: z.string().nullish(),
      reasoning: z.string().nullish(),
    })
    .optional(),
});

const CompletionSchema = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  choices: z.array(ChoiceSchema).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

function extractText(choice: z.infer<typeof ChoiceSchema>): string {
  const content = choice.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

function reasoningText(choice: z.infer<typeof ChoiceSchema>): string {
  return choice.message?.reasoning ?? choice.message?.reasoning_content ?? '';
}

function normalizeFinish(raw: string | null | undefined): ProviderResult['finishReason'] {
  switch (raw) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
    case 'sensitive':
      return 'content_filter';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'other';
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  return baseUrl.replace(/\/+$/, '') + suffix;
}

function classifyHttp(status: number, bodyText: string, secrets: readonly string[]): MeahError {
  const body = redact(bodyText.slice(0, 1000), secrets);
  const details = { status, body };
  if (status === 401 || status === 403) {
    return new MeahError(ErrorCodes.AUTH, `Provider rejected the credentials (HTTP ${status}).`, {
      retryable: false,
      hint: 'Check the API key environment variable named by apiKeyEnv, and that the key is valid for this baseUrl.',
      details,
    });
  }
  if (status === 404) {
    return new MeahError(ErrorCodes.INVALID_REQUEST, `Endpoint or model not found (HTTP 404).`, {
      retryable: false,
      hint: 'Verify baseUrl includes the API version prefix (e.g. https://aicredits.in/v1) and that the model name exists for this provider.',
      details,
    });
  }
  if (status === 429) {
    return new MeahError(ErrorCodes.RATE_LIMIT, 'Provider rate limit exceeded (HTTP 429).', {
      retryable: true,
      hint: 'Lower defaults.maxConcurrent or retry later.',
      details,
    });
  }
  if (status >= 500) {
    return new MeahError(ErrorCodes.PROVIDER, `Provider server error (HTTP ${status}).`, {
      retryable: true,
      details,
    });
  }
  return new MeahError(
    ErrorCodes.INVALID_REQUEST,
    `Provider rejected the request (HTTP ${status}).`,
    {
      retryable: false,
      details,
    },
  );
}

export type OpenAICompatibleOptions = {
  name: string;
  config: ProviderConfig;
  /** Resolved lazily so the key is never held on a long-lived object. */
  getApiKey: () => string;
  maxRetries: number;
  retryBaseMs: number;
  secrets?: readonly string[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): Provider {
  const { name, config, getApiKey, maxRetries, retryBaseMs } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const secrets = options.secrets ?? [];

  async function attempt(
    req: ProviderRequest,
    timeoutSignal: AbortSignal,
  ): Promise<Omit<ProviderResult, 'attempts' | 'latencyMs'>> {
    const apiKey = getApiKey();
    let response: Response;
    try {
      response = await doFetch(joinUrl(config.baseUrl, '/chat/completions'), {
        method: 'POST',
        signal: timeoutSignal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...config.headers,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxOutputTokens,
          temperature: req.temperature,
          stream: false,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
    } catch (cause) {
      const err = cause as Error;
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
      throw new MeahError(ErrorCodes.NETWORK, `Network failure contacting provider "${name}".`, {
        retryable: true,
        hint: `Check connectivity to ${config.baseUrl}.`,
        details: { reason: redact(err?.message ?? String(cause), secrets) },
        cause,
      });
    }

    const raw = await response.text();
    if (!response.ok) throw classifyHttp(response.status, raw, secrets);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new MeahError(
        ErrorCodes.MALFORMED_RESPONSE,
        `Provider "${name}" returned non-JSON output.`,
        {
          retryable: false,
          details: { snippet: redact(raw.slice(0, 400), secrets) },
          cause,
        },
      );
    }

    const parsed = CompletionSchema.safeParse(json);
    if (!parsed.success) {
      throw new MeahError(
        ErrorCodes.MALFORMED_RESPONSE,
        `Provider "${name}" response did not match the OpenAI chat-completions shape.`,
        { retryable: false, details: { issues: parsed.error.issues.slice(0, 5) } },
      );
    }

    const choice = parsed.data.choices[0]!;
    const text = extractText(choice);
    if (text.trim() === '') {
      const reasoning = reasoningText(choice);
      // A reasoning model can spend the whole output budget on its scratchpad
      // and return no content at all. That is a budget problem, not a broken
      // provider, so it gets its own actionable error.
      if (normalizeFinish(choice.finish_reason) === 'length') {
        throw new MeahError(
          ErrorCodes.INVALID_REQUEST,
          `Provider "${name}" returned no content: model "${req.model}" hit the ${req.maxOutputTokens}-token output limit${
            reasoning ? ' while still producing reasoning tokens' : ''
          }.`,
          {
            retryable: false,
            hint: 'Raise maxOutputTokens (reasoning models often need 2000+), or route this role to a non-reasoning model.',
            details: {
              finishReason: choice.finish_reason ?? null,
              reasoningChars: reasoning.length,
            },
          },
        );
      }
      throw new MeahError(
        ErrorCodes.MALFORMED_RESPONSE,
        `Provider "${name}" returned an empty completion.`,
        {
          retryable: false,
          details: { finishReason: choice.finish_reason ?? null, reasoningChars: reasoning.length },
        },
      );
    }

    return {
      text,
      provider: name,
      model: parsed.data.model ?? req.model,
      requestId: parsed.data.id ?? response.headers.get('x-request-id'),
      finishReason: normalizeFinish(choice.finish_reason),
      usage: {
        promptTokens: parsed.data.usage?.prompt_tokens ?? null,
        completionTokens: parsed.data.usage?.completion_tokens ?? null,
        totalTokens: parsed.data.usage?.total_tokens ?? null,
      },
    };
  }

  return {
    name,
    kind: config.kind,
    async complete(req: ProviderRequest): Promise<ProviderResult> {
      const started = Date.now();
      // timeoutMs is a TOTAL budget for this call, not a per-attempt one.
      // Retries share the same deadline, so N retries can never multiply the
      // wall-clock time the caller was promised.
      const deadline = started + req.timeoutMs;
      let lastError: unknown;

      const timedOut = (attempts: number) =>
        new MeahError(
          ErrorCodes.TIMEOUT,
          `Provider "${name}" did not complete within the ${req.timeoutMs}ms budget.`,
          {
            retryable: false,
            hint: 'Raise timeoutMs, or use a smaller model / shorter context.',
            details: {
              attempts,
              lastErrorCode: lastError instanceof MeahError ? lastError.code : null,
            },
          },
        );

      for (let attemptNo = 1; attemptNo <= maxRetries + 1; attemptNo++) {
        if (req.signal.aborted) {
          throw new MeahError(
            ErrorCodes.CANCELLED,
            'Worker was cancelled before the provider call.',
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw timedOut(attemptNo - 1);

        const timeoutController = new AbortController();
        const onAbort = () => timeoutController.abort(req.signal.reason);
        req.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(
          () => timeoutController.abort(new Error('meah_timeout')),
          remaining,
        );
        try {
          const result = await attempt(req, timeoutController.signal);
          return { ...result, latencyMs: Date.now() - started, attempts: attemptNo };
        } catch (cause) {
          lastError = cause;
          const aborted = timeoutController.signal.aborted;
          if (aborted && req.signal.aborted) {
            throw new MeahError(
              ErrorCodes.CANCELLED,
              'Worker was cancelled during the provider call.',
            );
          }
          if (aborted) throw timedOut(attemptNo);
          const retryable = cause instanceof MeahError && cause.retryable;
          if (!retryable || attemptNo > maxRetries) throw cause;
          // Never back off past the deadline: that would burn the remaining
          // budget sleeping instead of retrying, and report the wrong error.
          const backoff = retryBaseMs * 2 ** (attemptNo - 1);
          const left = deadline - Date.now();
          if (left <= backoff) throw timedOut(attemptNo);
          await sleep(backoff);
        } finally {
          clearTimeout(timer);
          req.signal.removeEventListener('abort', onAbort);
        }
      }
      throw lastError;
    },
  };
}
