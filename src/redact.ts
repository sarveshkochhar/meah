/**
 * Secret redaction. MEAH never returns or logs API keys, so every string that
 * leaves the process (log line, tool result, error message) passes through here.
 */

const PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Fa-f0-9]{32,}\.[A-Za-z0-9._-]{8,}\b/g, // z.ai style id.secret keys
  /\b(?:api[_-]?key|apikey|authorization|access[_-]?token)\s*[:=]\s*["']?[^\s"',}]{8,}/gi,
];

const REDACTED = '[REDACTED]';

/** Collect every value of env vars that MEAH treats as a credential source. */
export function collectEnvSecrets(apiKeyEnvNames: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of apiKeyEnvNames) {
    const value = process.env[name];
    if (value && value.trim().length >= 4) out.push(value.trim());
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(input: string, literalSecrets: readonly string[] = []): string {
  let out = input;
  for (const secret of literalSecrets) {
    if (secret.length < 4) continue;
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Deep-redact an arbitrary JSON-ish value, dropping obviously sensitive keys. */
export function redactDeep(value: unknown, literalSecrets: readonly string[] = []): unknown {
  const SENSITIVE_KEY = /^(authorization|api[_-]?key|apikey|token|secret|password)$/i;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return '[TRUNCATED]';
    if (typeof v === 'string') return redact(v, literalSecrets);
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY.test(k) ? REDACTED : walk(val, depth + 1);
      }
      return out;
    }
    return v;
  };
  return walk(value, 0);
}
