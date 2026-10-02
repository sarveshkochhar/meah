import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig, resolveApiKey, describeProviders } from '../src/config.ts';
import { MeahError } from '../src/errors.ts';
import { tempDir } from './helpers.ts';

const env = (extra: Record<string, string>) => extra as NodeJS.ProcessEnv;

describe('config', () => {
  test('loads providers from environment variables', async () => {
    const cwd = await tempDir();
    const config = loadConfig({
      cwd,
      configPath: null,
      env: env({
        MEAH_PROVIDER_GLM_BASE_URL: 'https://api.z.ai/api/paas/v4',
        MEAH_PROVIDER_GLM_API_KEY_ENV: 'MEAH_GLM_API_KEY',
        MEAH_PROVIDER_GLM_MODEL: 'glm-4.5-air',
        MEAH_PROVIDER_AICREDITS_BASE_URL: 'https://aicredits.in/v1',
        MEAH_PROVIDER_AICREDITS_API_KEY_ENV: 'MEAH_AICREDITS_API_KEY',
        MEAH_PROVIDER_AICREDITS_MODEL: 'gpt-4o-mini',
      }),
    });
    assert.deepEqual(Object.keys(config.providers).sort(), ['aicredits', 'glm']);
    // Each provider keeps its own base URL, key variable, and model catalog.
    assert.equal(config.providers.glm!.baseUrl, 'https://api.z.ai/api/paas/v4');
    assert.equal(config.providers.aicredits!.baseUrl, 'https://aicredits.in/v1');
    assert.notEqual(config.providers.glm!.apiKeyEnv, config.providers.aicredits!.apiKeyEnv);
    assert.notEqual(config.providers.glm!.defaultModel, config.providers.aicredits!.defaultModel);
  });

  test('loads and validates a config file, env overrides merge on top', async () => {
    const cwd = await tempDir();
    const file = path.join(cwd, 'meah.config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: {
          glm: {
            kind: 'openai-compatible',
            baseUrl: 'https://api.z.ai/api/paas/v4',
            apiKeyEnv: 'MEAH_GLM_API_KEY',
            defaultModel: 'glm-4.5-air',
          },
        },
        defaults: { maxConcurrent: 2 },
        roles: { coder: { provider: 'glm', model: 'glm-4.6' } },
      }),
    );
    const config = loadConfig({ cwd, env: env({ MEAH_MAX_CONCURRENT: '5' }) });
    assert.equal(config.sourcePath, file);
    assert.equal(config.defaults.maxConcurrent, 5, 'env overrides the file');
    assert.equal(config.roles.coder?.model, 'glm-4.6');
    assert.equal(config.defaults.permissionProfile, 'read-only', 'safe default');
    assert.equal(config.terminal.enabled, false, 'terminal off by default');
  });

  test('rejects unknown fields, bad urls, and credential-looking headers', async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, 'meah.config.json'),
      JSON.stringify({
        providers: {
          bad: {
            baseUrl: 'https://x.invalid/v1',
            apiKeyEnv: 'K_ENV',
            defaultModel: 'm',
            headers: { authorization: 'Bearer abc' },
          },
        },
      }),
    );
    assert.throws(
      () => loadConfig({ cwd, env: env({}) }),
      (err: unknown) => {
        assert.ok(err instanceof MeahError);
        assert.equal(err.code, 'E_CONFIG');
        assert.match(err.message, /credential/i);
        return true;
      },
    );
  });

  test('rejects a role pointing at an unknown provider', async () => {
    const cwd = await tempDir();
    await fs.writeFile(
      path.join(cwd, 'meah.config.json'),
      JSON.stringify({ roles: { coder: { provider: 'nope' } } }),
    );
    assert.throws(() => loadConfig({ cwd, env: env({}) }), /unknown provider/i);
  });

  test('resolveApiKey reads the environment and never lands on the config object', async () => {
    const cwd = await tempDir();
    const config = loadConfig({
      cwd,
      configPath: null,
      env: env({
        MEAH_PROVIDER_P_BASE_URL: 'https://x.invalid/v1',
        MEAH_PROVIDER_P_API_KEY_ENV: 'SECRET_KEY_VAR',
        MEAH_PROVIDER_P_MODEL: 'm',
      }),
    });
    assert.ok(!JSON.stringify(config).includes('super-secret-value'));
    assert.equal(
      resolveApiKey(config.providers.p!, env({ SECRET_KEY_VAR: 'super-secret-value' })),
      'super-secret-value',
    );
    assert.throws(() => resolveApiKey(config.providers.p!, env({})), /SECRET_KEY_VAR is not set/);
  });

  test('describeProviders exposes presence but never the key itself', async () => {
    const cwd = await tempDir();
    const config = loadConfig({
      cwd,
      configPath: null,
      env: env({
        MEAH_PROVIDER_P_BASE_URL: 'https://x.invalid/v1',
        MEAH_PROVIDER_P_API_KEY_ENV: 'SECRET_KEY_VAR',
        MEAH_PROVIDER_P_MODEL: 'm',
      }),
    });
    const described = describeProviders(
      config,
      env({ SECRET_KEY_VAR: 'sk-live-abcdefghijklmnop' }),
    );
    const serialized = JSON.stringify(described);
    assert.ok(!serialized.includes('sk-live-abcdefghijklmnop'));
    assert.equal(described[0]!.apiKeyPresent, true);
    assert.equal(described[0]!.apiKeyEnv, 'SECRET_KEY_VAR');
  });
});
