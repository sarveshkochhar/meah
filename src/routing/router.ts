import { MeahError, ErrorCodes } from '../errors.ts';
import { ROLES, type MeahConfig, type Role } from '../config.ts';

export type RouteRequest = {
  role: string;
  provider?: string;
  model?: string;
};

export type Route = {
  provider: string;
  model: string;
  role: string;
  systemOverride?: string;
  temperature?: number;
  /** Tried once, on the same provider, if the primary model call fails. */
  fallbackModel?: string;
  /** How the route was chosen, for observability and debugging. */
  source: 'explicit' | 'role-default' | 'sole-provider';
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Selection order: explicit provider/model wins, then the role default, then
 * the single configured provider when there is exactly one. Ambiguity is an
 * error rather than a silent guess.
 */
export function resolveRoute(config: MeahConfig, req: RouteRequest): Route {
  const providerNames = Object.keys(config.providers);
  if (providerNames.length === 0) {
    throw new MeahError(ErrorCodes.CONFIG, 'No providers are configured.', {
      hint: 'Add a provider to meah.config.json or set MEAH_PROVIDER_<NAME>_BASE_URL / _API_KEY_ENV / _MODEL.',
    });
  }

  const roleRoute = isRole(req.role) ? config.roles[req.role] : undefined;

  let providerName: string;
  let source: Route['source'];
  if (req.provider) {
    providerName = req.provider;
    source = 'explicit';
  } else if (roleRoute) {
    providerName = roleRoute.provider;
    source = 'role-default';
  } else if (providerNames.length === 1) {
    providerName = providerNames[0]!;
    source = 'sole-provider';
  } else {
    throw new MeahError(
      ErrorCodes.INVALID_REQUEST,
      `No route for role "${req.role}" and ${providerNames.length} providers are configured.`,
      {
        hint: `Pass "provider" explicitly, or add a roles."${req.role}" default. Providers: ${providerNames.join(', ')}`,
      },
    );
  }

  const provider = config.providers[providerName];
  if (!provider) {
    throw new MeahError(ErrorCodes.INVALID_REQUEST, `Unknown provider "${providerName}".`, {
      hint: `Configured providers: ${providerNames.join(', ')}`,
    });
  }

  const model =
    req.model ??
    (source === 'role-default' ? roleRoute?.model : undefined) ??
    provider.defaultModel;

  // A declared catalog is authoritative for that provider only; providers never
  // share a model list.
  if (provider.models.length > 0 && !provider.models.includes(model)) {
    throw new MeahError(
      ErrorCodes.INVALID_REQUEST,
      `Model "${model}" is not in the configured catalog for provider "${providerName}".`,
      { hint: `Known models for ${providerName}: ${provider.models.join(', ')}` },
    );
  }

  const route: Route = {
    provider: providerName,
    model,
    role: req.role,
    source: req.model && source !== 'explicit' ? 'explicit' : source,
  };
  if (roleRoute?.systemPrompt) route.systemOverride = roleRoute.systemPrompt;
  if (roleRoute?.temperature !== undefined) route.temperature = roleRoute.temperature;
  // Only fall back for the role's own configured model, not a caller-supplied
  // explicit override — an explicit request means "use exactly this model".
  if (!req.model && roleRoute?.fallbackModel && roleRoute.fallbackModel !== model) {
    if (provider.models.length === 0 || provider.models.includes(roleRoute.fallbackModel)) {
      route.fallbackModel = roleRoute.fallbackModel;
    }
  }
  return route;
}

/** Human-readable routing table for documentation and `meah_list_models`. */
export function describeRoutes(config: MeahConfig) {
  return ROLES.map((role) => {
    const configured = config.roles[role];
    let effective: Route | null = null;
    try {
      effective = resolveRoute(config, { role });
    } catch {
      effective = null;
    }
    return {
      role,
      configured: configured ?? null,
      effective: effective
        ? { provider: effective.provider, model: effective.model, source: effective.source }
        : null,
    };
  });
}
