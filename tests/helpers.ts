import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { loadConfig, type MeahConfig } from '../src/config.ts';
import { createLogger, type Logger } from '../src/logger.ts';
import { WorkerManager } from '../src/runtime/manager.ts';
import { createMockProvider } from '../src/providers/mock.ts';
import type { Provider } from '../src/providers/types.ts';

export function silentLogger(): Logger {
  return createLogger('silent', []);
}

export async function tempDir(prefix = 'meah-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function testConfig(overrides: Partial<MeahConfig> = {}): Promise<MeahConfig> {
  const root = await tempDir();
  const base = loadConfig({
    env: {
      MEAH_PROVIDER_TESTP_BASE_URL: 'https://example.invalid/v1',
      MEAH_PROVIDER_TESTP_API_KEY_ENV: 'MEAH_TEST_API_KEY',
      MEAH_PROVIDER_TESTP_MODEL: 'test-model',
      MEAH_LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv,
    configPath: null,
    cwd: root,
  });
  return { ...base, workspaceRoot: path.join(root, 'workspaces'), ...overrides };
}

export function managerWithMock(
  config: MeahConfig,
  provider: Provider = createMockProvider({ name: 'testp' }),
): WorkerManager {
  return new WorkerManager({
    config,
    logger: silentLogger(),
    env: { MEAH_TEST_API_KEY: 'test-key-value-123456' } as NodeJS.ProcessEnv,
    providerFactory: () => provider,
  });
}
