import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, boundResult, systemPromptFor } from '../src/runtime/context.ts';
import { resolveRoute, describeRoutes } from '../src/routing/router.ts';
import { loadConfig } from '../src/config.ts';
import { tempDir } from './helpers.ts';

const env = (extra: Record<string, string>) => extra as NodeJS.ProcessEnv;

describe('context packaging', () => {
  test('includes only what was supplied, labelled untrusted', () => {
    const built = buildPrompt(
      {
        task: 'Summarize the changelog.',
        role: 'summarizer',
        context: [{ name: 'CHANGELOG.md', kind: 'file', text: 'v1: first release' }],
        constraints: ['Under 100 words'],
        expectedOutput: 'Bullet list',
      },
      { maxContextChars: 5000 },
    );
    assert.match(built.user, /# Task/);
    assert.match(built.user, /Under 100 words/);
    assert.match(built.user, /BEGIN UNTRUSTED file: CHANGELOG\.md/);
    assert.match(built.user, /v1: first release/);
    assert.match(built.system, /untrusted data/i);
    assert.match(built.system, /NO tools/);
    assert.equal(built.truncated, false);
  });

  test('truncates oversized items and drops what does not fit', () => {
    const built = buildPrompt(
      {
        task: 'Review',
        role: 'reviewer',
        context: [
          { name: 'big', kind: 'text', text: 'A'.repeat(10000) },
          { name: 'second', kind: 'text', text: 'B'.repeat(10000) },
          { name: 'third', kind: 'text', text: 'C'.repeat(10000) },
        ],
        constraints: [],
      },
      { maxContextChars: 2000 },
    );
    assert.equal(built.truncated, true);
    assert.ok(built.user.length <= 2200, `prompt was ${built.user.length} chars`);
    assert.ok(built.truncatedItems.includes('big'));
    assert.deepEqual(built.droppedItems, ['second', 'third']);
    assert.match(built.user, /omitted 2 context item/);
  });

  test('rejects a task that alone exceeds the context budget', () => {
    assert.throws(
      () =>
        buildPrompt(
          { task: 'x'.repeat(1000), role: 'coder', context: [], constraints: [] },
          { maxContextChars: 300 },
        ),
      /E_CONTEXT_TOO_LARGE|over the 300 char limit/,
    );
  });

  test('every role has a distinct system prompt', () => {
    const roles = ['researcher', 'builder', 'coder', 'debugger', 'reviewer', 'summarizer'];
    const prompts = roles.map((r) => systemPromptFor(r));
    assert.equal(new Set(prompts).size, roles.length, 'each role must get its own prompt');
    for (const p of prompts) {
      // The safety boundary is appended to every role without exception.
      assert.match(p, /untrusted data/i);
      assert.match(p, /NO tools/);
    }
  });

  test('builder, coder and debugger are given genuinely different jobs', () => {
    const builder = systemPromptFor('builder');
    const coder = systemPromptFor('coder');
    const debug = systemPromptFor('debugger');

    // builder creates something new, end to end.
    assert.match(builder, /build worker/);
    assert.match(builder, /does not exist yet/);
    assert.match(builder, /full path and complete contents/);

    // coder edits what already exists, minimally.
    assert.match(coder, /coding worker/);
    assert.match(coder, /already exists/);
    assert.match(coder, /least that does the job/);

    // debugger reasons symptom -> root cause, and must not paper over it.
    assert.match(debug, /debugging worker/);
    assert.match(debug, /root cause/);
    assert.match(debug, /CONFIRM the diagnosis/);
    assert.match(debug, /only suppresses the error/);
  });

  test('role system prompts differ and an override is honoured', () => {
    assert.match(systemPromptFor('coder'), /coding worker/);
    assert.match(systemPromptFor('reviewer'), /review worker/);
    assert.match(systemPromptFor('nonstandard'), /isolated external worker/);
    assert.match(systemPromptFor('coder', 'You are a haiku bot.'), /haiku bot/);
    // Boundary rules survive an override.
    assert.match(systemPromptFor('coder', 'You are a haiku bot.'), /untrusted data/i);
  });

  test('boundResult caps provider output', () => {
    assert.deepEqual(boundResult('short', 100), { text: 'short', truncated: false });
    const bounded = boundResult('y'.repeat(500), 100);
    assert.equal(bounded.truncated, true);
    assert.match(bounded.text, /truncated by MEAH: 400 chars omitted/);
  });
});

describe('routing', () => {
  const twoProviders = async () =>
    loadConfig({
      cwd: await tempDir(),
      configPath: null,
      env: env({
        MEAH_PROVIDER_GLM_BASE_URL: 'https://api.z.ai/api/paas/v4',
        MEAH_PROVIDER_GLM_API_KEY_ENV: 'MEAH_GLM_API_KEY',
        MEAH_PROVIDER_GLM_MODEL: 'glm-4.5-air',
        MEAH_PROVIDER_GLM_MODELS: 'glm-4.5-air,glm-4.6',
        MEAH_PROVIDER_AICREDITS_BASE_URL: 'https://aicredits.in/v1',
        MEAH_PROVIDER_AICREDITS_API_KEY_ENV: 'MEAH_AICREDITS_API_KEY',
        MEAH_PROVIDER_AICREDITS_MODEL: 'gpt-4o-mini',
        MEAH_ROLE_CODER_PROVIDER: 'glm',
        MEAH_ROLE_CODER_MODEL: 'glm-4.6',
        MEAH_ROLE_SUMMARIZER_PROVIDER: 'aicredits',
      }),
    });

  test('role defaults route to the configured provider and model', async () => {
    const config = await twoProviders();
    assert.deepEqual(
      { ...resolveRoute(config, { role: 'coder' }) },
      { provider: 'glm', model: 'glm-4.6', role: 'coder', source: 'role-default' },
    );
    const summarizer = resolveRoute(config, { role: 'summarizer' });
    assert.equal(summarizer.provider, 'aicredits');
    assert.equal(summarizer.model, 'gpt-4o-mini', 'falls back to that provider defaultModel');
  });

  test('explicit provider/model overrides the role default', async () => {
    const config = await twoProviders();
    const route = resolveRoute(config, {
      role: 'coder',
      provider: 'aicredits',
      model: 'gpt-4o-mini',
    });
    assert.equal(route.provider, 'aicredits');
    assert.equal(route.model, 'gpt-4o-mini');
    assert.equal(route.source, 'explicit');
  });

  test('ambiguous role with several providers is an error, not a guess', async () => {
    const config = await twoProviders();
    assert.throws(
      () => resolveRoute(config, { role: 'researcher' }),
      /No route for role "researcher"/,
    );
  });

  test('single-provider setups route everything to it', async () => {
    const config = loadConfig({
      cwd: await tempDir(),
      configPath: null,
      env: env({
        MEAH_PROVIDER_ONLY_BASE_URL: 'https://aicredits.in/v1',
        MEAH_PROVIDER_ONLY_API_KEY_ENV: 'K',
        MEAH_PROVIDER_ONLY_MODEL: 'm1',
      }),
    });
    assert.equal(resolveRoute(config, { role: 'researcher' }).source, 'sole-provider');
    assert.equal(resolveRoute(config, { role: 'researcher' }).model, 'm1');
  });

  test('a model outside a declared catalog is rejected', async () => {
    const config = await twoProviders();
    assert.throws(
      () => resolveRoute(config, { role: 'coder', provider: 'glm', model: 'gpt-4o-mini' }),
      /not in the configured catalog for provider "glm"/,
    );
  });

  test('unknown provider produces an actionable error', async () => {
    const config = await twoProviders();
    assert.throws(
      () => resolveRoute(config, { role: 'coder', provider: 'nope' }),
      /Unknown provider "nope"/,
    );
  });

  test('each role routes to its own model, independently', async () => {
    const config = loadConfig({
      cwd: await tempDir(),
      configPath: null,
      env: env({
        MEAH_PROVIDER_GW_BASE_URL: 'https://aicredits.in/v1',
        MEAH_PROVIDER_GW_API_KEY_ENV: 'K',
        MEAH_PROVIDER_GW_MODEL: 'fallback-model',
        MEAH_ROLE_BUILDER_MODEL: 'z-ai/glm-4.7',
        MEAH_ROLE_CODER_MODEL: 'z-ai/glm-4.7',
        MEAH_ROLE_DEBUGGER_MODEL: 'z-ai/glm-4.7',
        MEAH_ROLE_REVIEWER_MODEL: 'z-ai/glm-4.6',
        MEAH_ROLE_SUMMARIZER_MODEL: 'openai/gpt-4o-mini',
      }),
    });
    assert.equal(resolveRoute(config, { role: 'builder' }).model, 'z-ai/glm-4.7');
    assert.equal(resolveRoute(config, { role: 'debugger' }).model, 'z-ai/glm-4.7');
    assert.equal(resolveRoute(config, { role: 'summarizer' }).model, 'openai/gpt-4o-mini');
    assert.equal(resolveRoute(config, { role: 'reviewer' }).model, 'z-ai/glm-4.6');
    // A role with no explicit model still falls back to the provider default.
    assert.equal(resolveRoute(config, { role: 'researcher' }).model, 'fallback-model');
    // An explicit override still beats the role default.
    assert.equal(
      resolveRoute(config, { role: 'debugger', model: 'openai/gpt-4o-mini' }).model,
      'openai/gpt-4o-mini',
    );
  });

  test('describeRoutes reports every role', async () => {
    const config = await twoProviders();
    const routes = describeRoutes(config);
    assert.equal(routes.length, 6);
    assert.equal(routes.find((r) => r.role === 'coder')!.effective!.model, 'glm-4.6');
    assert.equal(routes.find((r) => r.role === 'researcher')!.effective, null);
  });
});
