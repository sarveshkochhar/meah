import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderConfigSchema } from '../src/config.ts';
import { MeahError } from '../src/errors.ts';

const config = ProviderConfigSchema.parse({
  baseUrl: 'https://aicredits.in/v1',
  apiKeyEnv: 'FAKE_KEY_ENV',
  defaultModel: 'test-model',
});

const KEY = 'sk-testkeyvalue0123456789';

type FetchCall = { url: string; init: RequestInit };

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: (init ?? {}) as RequestInit };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeProvider(fetchImpl: typeof fetch, maxRetries = 0) {
  return createOpenAICompatibleProvider({
    name: 'aicredits',
    config,
    getApiKey: () => KEY,
    maxRetries,
    retryBaseMs: 1,
    secrets: [KEY],
    fetchImpl,
    sleep: async () => undefined,
  });
}

const okBody = (text = 'hello world') =>
  new Response(
    JSON.stringify({
      id: 'req-42',
      model: 'test-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const request = (signal: AbortSignal) => ({
  model: 'test-model',
  system: 'sys',
  user: 'do the thing',
  maxOutputTokens: 256,
  temperature: 0.2,
  timeoutMs: 5000,
  signal,
});

describe('openai-compatible provider', () => {
  test('posts to /chat/completions and normalizes a success', async () => {
    const { impl, calls } = stubFetch(() => okBody());
    const result = await makeProvider(impl).complete(request(new AbortController().signal));

    assert.equal(calls[0]!.url, 'https://aicredits.in/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.model, 'test-model');
    assert.equal(body.max_tokens, 256);
    assert.equal(body.stream, false);
    assert.deepEqual(
      body.messages.map((m: { role: string }) => m.role),
      ['system', 'user'],
    );

    assert.equal(result.text, 'hello world');
    assert.equal(result.provider, 'aicredits');
    assert.equal(result.requestId, 'req-42');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { promptTokens: 11, completionTokens: 3, totalTokens: 14 });
    assert.equal(result.attempts, 1);
  });

  test('trailing slashes in baseUrl are handled', async () => {
    const { impl, calls } = stubFetch(() => okBody());
    const p = createOpenAICompatibleProvider({
      name: 'x',
      config: ProviderConfigSchema.parse({ ...config, baseUrl: 'https://aicredits.in/v1/' }),
      getApiKey: () => KEY,
      maxRetries: 0,
      retryBaseMs: 1,
      fetchImpl: impl,
    });
    await p.complete(request(new AbortController().signal));
    assert.equal(calls[0]!.url, 'https://aicredits.in/v1/chat/completions');
  });

  test('handles array-style content parts', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'r',
            choices: [
              {
                finish_reason: 'length',
                message: { content: [{ text: 'part1 ' }, { text: 'part2' }] },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const result = await makeProvider(impl).complete(request(new AbortController().signal));
    assert.equal(result.text, 'part1 part2');
    assert.equal(result.finishReason, 'length');
    assert.deepEqual(result.usage, {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    });
  });

  const httpCases: Array<[number, string, boolean]> = [
    [401, 'E_AUTH', false],
    [403, 'E_AUTH', false],
    [404, 'E_INVALID_REQUEST', false],
    [400, 'E_INVALID_REQUEST', false],
    [429, 'E_RATE_LIMIT', true],
    [500, 'E_PROVIDER', true],
    [503, 'E_PROVIDER', true],
  ];
  for (const [status, code, retryable] of httpCases) {
    test(`HTTP ${status} maps to ${code}`, async () => {
      const { impl } = stubFetch(() => new Response('{"error":"nope"}', { status }));
      await assert.rejects(
        makeProvider(impl).complete(request(new AbortController().signal)),
        (err: unknown) => {
          assert.ok(err instanceof MeahError);
          assert.equal(err.code, code);
          assert.equal(err.retryable, retryable);
          return true;
        },
      );
    });
  }

  test('error details never contain the API key', async () => {
    const { impl } = stubFetch(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }));
    await assert.rejects(
      makeProvider(impl).complete(request(new AbortController().signal)),
      (err: unknown) => {
        const serialized = JSON.stringify((err as MeahError).toJSON());
        assert.ok(!serialized.includes(KEY), serialized);
        assert.match(serialized, /REDACTED/);
        return true;
      },
    );
  });

  test('non-JSON and shape-mismatched responses map to E_MALFORMED_RESPONSE', async () => {
    const { impl: notJson } = stubFetch(
      () => new Response('<html>gateway</html>', { status: 200 }),
    );
    await assert.rejects(
      makeProvider(notJson).complete(request(new AbortController().signal)),
      /non-JSON/,
    );

    const { impl: wrongShape } = stubFetch(
      () => new Response(JSON.stringify({ result: 'oops' }), { status: 200 }),
    );
    await assert.rejects(
      makeProvider(wrongShape).complete(request(new AbortController().signal)),
      /did not match the OpenAI chat-completions shape/,
    );

    const { impl: empty } = stubFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    );
    await assert.rejects(
      makeProvider(empty).complete(request(new AbortController().signal)),
      /empty completion/,
    );
  });

  test('a reasoning model that exhausts the budget gives an actionable error', async () => {
    // Observed live: gateways return content:null with the whole budget spent
    // on `reasoning`, and finish_reason "length".
    const { impl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'r',
            choices: [
              {
                finish_reason: 'length',
                message: { content: null, reasoning: 'thinking '.repeat(40) },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    await assert.rejects(
      makeProvider(impl).complete(request(new AbortController().signal)),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_INVALID_REQUEST');
        assert.equal(err.retryable, false);
        assert.match(err.message, /256-token output limit/);
        assert.match(err.message, /reasoning tokens/);
        assert.match(err.hint!, /Raise maxOutputTokens/);
        assert.ok((err.details!.reasoningChars as number) > 0);
        return true;
      },
    );
  });

  test('reasoning is never used as the result text', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'r',
            choices: [
              {
                finish_reason: 'stop',
                message: { content: 'the answer', reasoning: 'my private scratchpad' },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const result = await makeProvider(impl).complete(request(new AbortController().signal));
    assert.equal(result.text, 'the answer');
    assert.ok(!result.text.includes('scratchpad'));
  });

  test('an upstream 429 relayed by a gateway is still E_RATE_LIMIT', async () => {
    // Observed live from aicredits when its upstream provider was saturated.
    const { impl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "All upstream providers failed for model 'x'. Last error: provider returned 429",
              type: 'upstream_error',
              code: 429,
            },
          }),
          { status: 429 },
        ),
    );
    await assert.rejects(
      makeProvider(impl).complete(request(new AbortController().signal)),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_RATE_LIMIT');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test('network failure maps to E_NETWORK and is retryable', async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(
      makeProvider(impl).complete(request(new AbortController().signal)),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_NETWORK');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test('retries capped transient failures only', async () => {
    let attempts = 0;
    const { impl } = stubFetch(() => {
      attempts++;
      return attempts < 3 ? new Response('rate limited', { status: 429 }) : okBody('recovered');
    });
    const result = await makeProvider(impl, 2).complete(request(new AbortController().signal));
    assert.equal(result.text, 'recovered');
    assert.equal(result.attempts, 3);

    let authAttempts = 0;
    const { impl: authImpl } = stubFetch(() => {
      authAttempts++;
      return new Response('bad key', { status: 401 });
    });
    await assert.rejects(
      makeProvider(authImpl, 3).complete(request(new AbortController().signal)),
      /E_AUTH|credentials/,
    );
    assert.equal(authAttempts, 1, 'auth failures must not be retried');
  });

  test('timeoutMs is a TOTAL budget shared across retries', async () => {
    // Regression: the timeout used to apply per attempt, so N retries could
    // multiply the wall-clock time the caller was promised.
    let calls = 0;
    const slow = (async (_url: unknown, init: any) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 400);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    const provider = createOpenAICompatibleProvider({
      name: 'p',
      config,
      getApiKey: () => KEY,
      maxRetries: 3,
      retryBaseMs: 1,
      fetchImpl: slow,
      sleep: async () => undefined,
    });

    const started = Date.now();
    await assert.rejects(
      provider.complete({ ...request(new AbortController().signal), timeoutMs: 500 }),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_TIMEOUT');
        assert.match(err.message, /500ms budget/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 900, `took ${elapsed}ms across ${calls} attempts for a 500ms budget`);
  });

  test('backoff never sleeps past the deadline', async () => {
    const { impl } = stubFetch(() => new Response('rate limited', { status: 429 }));
    const provider = createOpenAICompatibleProvider({
      name: 'p',
      config,
      getApiKey: () => KEY,
      maxRetries: 5,
      retryBaseMs: 10_000, // far larger than the budget below
      fetchImpl: impl,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    const started = Date.now();
    await assert.rejects(
      provider.complete({ ...request(new AbortController().signal), timeoutMs: 1000 }),
      (err: unknown) => (err as MeahError).code === 'E_TIMEOUT',
    );
    assert.ok(Date.now() - started < 1500, 'must not sleep out a 10s backoff inside a 1s budget');
  });

  test('gives up after maxRetries', async () => {
    let attempts = 0;
    const { impl } = stubFetch(() => {
      attempts++;
      return new Response('boom', { status: 500 });
    });
    await assert.rejects(
      makeProvider(impl, 2).complete(request(new AbortController().signal)),
      /E_PROVIDER|server error/,
    );
    assert.equal(attempts, 3);
  });

  test('timeout maps to E_TIMEOUT', async () => {
    const { impl } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    await assert.rejects(
      makeProvider(impl).complete({ ...request(new AbortController().signal), timeoutMs: 1000 }),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_TIMEOUT');
        return true;
      },
    );
  });

  test('caller cancellation maps to E_CANCELLED', async () => {
    const controller = new AbortController();
    const { impl } = stubFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const promise = makeProvider(impl).complete(request(controller.signal));
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof MeahError);
      assert.equal(err.code, 'E_CANCELLED');
      return true;
    });
  });

  test('an already-aborted signal short-circuits before any request', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = stubFetch(() => okBody());
    await assert.rejects(makeProvider(impl).complete(request(controller.signal)), /cancelled/i);
    assert.equal(calls.length, 0);
  });
});
