import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MeahError, ErrorCodes } from './errors.ts';

export const ROLES = [
  'researcher',
  'builder',
  'coder',
  'debugger',
  'reviewer',
  'summarizer',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSION_PROFILES = [
  'none',
  'read-only',
  'workspace-write',
  'workspace-exec',
] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

const EnvVarName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'apiKeyEnv must be an UPPER_SNAKE_CASE environment variable name');

export const ProviderConfigSchema = z
  .object({
    kind: z.literal('openai-compatible').default('openai-compatible'),
    baseUrl: z.string().url(),
    apiKeyEnv: EnvVarName,
    defaultModel: z.string().min(1),
    /** Optional catalog; each provider has its own. Never assume a shared one. */
    models: z.array(z.string().min(1)).default([]),
    /** Extra non-secret headers (e.g. routing hints). Credential-looking values are rejected. */
    headers: z.record(z.string()).default({}),
    description: z.string().optional(),
  })
  .strict();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const RoleRouteSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    /** Tried once, on the same provider, if the primary model call fails. */
    fallbackModel: z.string().min(1).optional(),
    systemPrompt: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export type RoleRoute = z.infer<typeof RoleRouteSchema>;

export const DefaultsSchema = z
  .object({
    timeoutMs: z.number().int().min(1000).max(600000).default(120000),
    maxOutputTokens: z.number().int().min(16).max(32768).default(4096),
    maxConcurrent: z.number().int().min(1).max(16).default(3),
    maxContextChars: z.number().int().min(200).max(400000).default(60000),
    maxResultChars: z.number().int().min(200).max(400000).default(40000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    retryBaseMs: z.number().int().min(10).max(10000).default(400),
    temperature: z.number().min(0).max(2).default(0.2),
    permissionProfile: z.enum(PERMISSION_PROFILES).default('read-only'),
    retainTranscripts: z.boolean().default(false),
    cleanupWorkspaceOnFinish: z.boolean().default(false),
  })
  .strict();

export const TerminalSchema = z
  .object({
    /** Terminal execution is opt-in and additionally gated by the permission profile. */
    enabled: z.boolean().default(false),
    allowlist: z
      .array(z.string().min(1))
      .default(['node', 'npm', 'ls', 'cat', 'rg', 'grep', 'git']),
    timeoutMs: z.number().int().min(500).max(120000).default(15000),
    maxOutputBytes: z.number().int().min(256).max(1000000).default(32768),
    maxCommandsPerWorker: z.number().int().min(1).max(20).default(4),
  })
  .strict();

export const ConfigFileSchema = z
  .object({
    providers: z.record(ProviderConfigSchema).default({}),
    defaults: DefaultsSchema.default({}),
    roles: z.record(z.enum(ROLES), RoleRouteSchema).default({}),
    terminal: TerminalSchema.default({}),
    workspaceRoot: z.string().min(1).optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type MeahConfig = {
  providers: Record<string, ProviderConfig>;
  defaults: z.infer<typeof DefaultsSchema>;
  roles: Partial<Record<Role, RoleRoute>>;
  terminal: z.infer<typeof TerminalSchema>;
  workspaceRoot: string;
  logLevel: ConfigFile['logLevel'];
  /** Absolute path of the config file that was loaded, if any. */
  sourcePath: string | null;
};

/**
 * Providers may also be declared purely through the environment:
 *   MEAH_PROVIDER_GLM_BASE_URL / _API_KEY_ENV / _MODEL / _MODELS / _DESCRIPTION
 */
function providersFromEnv(env: NodeJS.ProcessEnv): Record<string, Record<string, unknown>> {
  const found: Record<string, Record<string, unknown>> = {};
  const re =
    /^MEAH_PROVIDER_([A-Z0-9]+(?:_[A-Z0-9]+)*?)_(BASE_URL|API_KEY_ENV|MODELS|MODEL|DESCRIPTION)$/;
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const m = re.exec(key);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    const field = m[2]!;
    const entry = (found[name] ??= {});
    if (field === 'BASE_URL') entry.baseUrl = value;
    else if (field === 'API_KEY_ENV') entry.apiKeyEnv = value;
    else if (field === 'MODEL') entry.defaultModel = value;
    else if (field === 'DESCRIPTION') entry.description = value;
    else
      entry.models = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return found;
}

function parseNumberEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new MeahError(ErrorCodes.CONFIG, `${key} must be a number, got "${raw}".`);
  }
  return n;
}

export type LoadOptions = {
  env?: NodeJS.ProcessEnv;
  configPath?: string | null;
  cwd?: string;
};

export function loadConfig(options: LoadOptions = {}): MeahConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const explicit = options.configPath ?? env.MEAH_CONFIG ?? null;
  const candidate = explicit ? path.resolve(cwd, explicit) : path.resolve(cwd, 'meah.config.json');
  let fileRaw: unknown = {};
  let sourcePath: string | null = null;

  if (existsSync(candidate)) {
    sourcePath = candidate;
    try {
      fileRaw = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (cause) {
      throw new MeahError(ErrorCodes.CONFIG, `Config file ${candidate} is not valid JSON.`, {
        cause,
      });
    }
  } else if (explicit) {
    throw new MeahError(ErrorCodes.CONFIG, `Config file not found: ${candidate}`, {
      hint: 'Set MEAH_CONFIG to an existing file, or unset it to use environment-only configuration.',
    });
  }

  const parsedFile = ConfigFileSchema.safeParse(fileRaw);
  if (!parsedFile.success) {
    throw new MeahError(
      ErrorCodes.CONFIG,
      `Invalid config${sourcePath ? ` in ${sourcePath}` : ''}.`,
      { details: { issues: parsedFile.error.issues } },
    );
  }
  const base = parsedFile.data;

  // Environment-declared providers merge on top of the file.
  const envProviders = providersFromEnv(env);
  const mergedProviders: Record<string, unknown> = { ...base.providers };
  for (const [name, partial] of Object.entries(envProviders)) {
    mergedProviders[name] = {
      ...(mergedProviders[name] as Record<string, unknown> | undefined),
      ...partial,
    };
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [name, raw] of Object.entries(mergedProviders)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      throw new MeahError(ErrorCodes.CONFIG, `Invalid provider name "${name}".`, {
        hint: 'Provider names must be lowercase alphanumeric with - or _.',
      });
    }
    const parsed = ProviderConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MeahError(ErrorCodes.CONFIG, `Invalid configuration for provider "${name}".`, {
        details: { issues: parsed.error.issues },
      });
    }
    for (const [hk, hv] of Object.entries(parsed.data.headers)) {
      if (/^(authorization|api-key|x-api-key)$/i.test(hk) || /[A-Za-z0-9]{20,}/.test(hv)) {
        throw new MeahError(
          ErrorCodes.CONFIG,
          `Provider "${name}" header "${hk}" looks like a credential.`,
          { hint: 'Credentials belong in the environment variable named by apiKeyEnv.' },
        );
      }
    }
    if (!/^https?:\/\//i.test(parsed.data.baseUrl)) {
      throw new MeahError(ErrorCodes.CONFIG, `Provider "${name}" baseUrl must be http(s).`);
    }
    providers[name] = parsed.data;
  }

  const defaults = DefaultsSchema.parse({
    ...base.defaults,
    timeoutMs: parseNumberEnv(env, 'MEAH_TIMEOUT_MS') ?? base.defaults.timeoutMs,
    maxOutputTokens: parseNumberEnv(env, 'MEAH_MAX_OUTPUT_TOKENS') ?? base.defaults.maxOutputTokens,
    maxConcurrent: parseNumberEnv(env, 'MEAH_MAX_CONCURRENT') ?? base.defaults.maxConcurrent,
    maxContextChars: parseNumberEnv(env, 'MEAH_MAX_CONTEXT_CHARS') ?? base.defaults.maxContextChars,
    retainTranscripts:
      env.MEAH_RETAIN_TRANSCRIPTS !== undefined
        ? env.MEAH_RETAIN_TRANSCRIPTS === 'true'
        : base.defaults.retainTranscripts,
  });

  const terminal = TerminalSchema.parse({
    ...base.terminal,
    enabled:
      env.MEAH_TERMINAL_ENABLED !== undefined
        ? env.MEAH_TERMINAL_ENABLED === 'true'
        : base.terminal.enabled,
  });

  // Offline demo/smoke-test provider. Deterministic, no network, no key.
  if (env.MEAH_ENABLE_MOCK_PROVIDER === 'true' && !providers.mock) {
    providers.mock = ProviderConfigSchema.parse({
      baseUrl: 'http://localhost/mock',
      apiKeyEnv: 'MEAH_MOCK_API_KEY',
      defaultModel: 'mock-1',
      description: 'Built-in deterministic mock provider (no network, no API key).',
    });
  }

  const providerNames = Object.keys(providers);
  const roles: Partial<Record<Role, RoleRoute>> = { ...base.roles };
  for (const role of ROLES) {
    const envProvider = env[`MEAH_ROLE_${role.toUpperCase()}_PROVIDER`];
    const envModel = env[`MEAH_ROLE_${role.toUpperCase()}_MODEL`];
    const envFallbackModel = env[`MEAH_ROLE_${role.toUpperCase()}_FALLBACK_MODEL`];
    if (envProvider || envModel || envFallbackModel) {
      const existing = roles[role];
      const provider = envProvider ?? existing?.provider ?? providerNames[0];
      if (!provider) {
        throw new MeahError(ErrorCodes.CONFIG, `Role "${role}" has a model but no provider.`);
      }
      roles[role] = {
        ...existing,
        provider,
        ...(envModel ? { model: envModel } : {}),
        ...(envFallbackModel ? { fallbackModel: envFallbackModel } : {}),
      };
    }
  }
  for (const [role, route] of Object.entries(roles)) {
    if (route && !providers[route.provider]) {
      throw new MeahError(
        ErrorCodes.CONFIG,
        `Role "${role}" points at unknown provider "${route.provider}".`,
        { hint: `Known providers: ${providerNames.join(', ') || '(none configured)'}` },
      );
    }
  }

  const workspaceRoot = path.resolve(
    cwd,
    env.MEAH_WORKSPACE_ROOT ?? base.workspaceRoot ?? 'workspaces',
  );

  const logLevel = (env.MEAH_LOG_LEVEL as ConfigFile['logLevel'] | undefined) ?? base.logLevel;

  return { providers, defaults, roles, terminal, workspaceRoot, logLevel, sourcePath };
}

/**
 * Resolve a provider's API key at call time. The key is never stored on the
 * config object, never serialized, and never returned through a tool.
 */
export function resolveApiKey(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = env[provider.apiKeyEnv];
  if (!key || key.trim() === '') {
    throw new MeahError(
      ErrorCodes.CONFIG,
      `Missing API key: environment variable ${provider.apiKeyEnv} is not set.`,
      {
        hint: `Export ${provider.apiKeyEnv} in the environment that launches the MEAH MCP server (see .env.example).`,
      },
    );
  }
  return key.trim();
}

export function apiKeyEnvNames(config: MeahConfig): string[] {
  return [...new Set(Object.values(config.providers).map((p) => p.apiKeyEnv))];
}

/** Public, secret-free view of providers for `meah_list_models`. */
export function describeProviders(config: MeahConfig, env: NodeJS.ProcessEnv = process.env) {
  return Object.entries(config.providers).map(([name, p]) => ({
    provider: name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    models: p.models.length > 0 ? p.models : [p.defaultModel],
    apiKeyEnv: p.apiKeyEnv,
    apiKeyPresent: Boolean(env[p.apiKeyEnv] && env[p.apiKeyEnv]!.trim() !== ''),
    description: p.description,
  }));
}
