/**
 * Stable, normalized MEAH error codes. These are part of the tool contract:
 * callers (Claude) may branch on `code`, so values must not change casually.
 */
export const ErrorCodes = {
  CONFIG: 'E_CONFIG',
  AUTH: 'E_AUTH',
  INVALID_REQUEST: 'E_INVALID_REQUEST',
  RATE_LIMIT: 'E_RATE_LIMIT',
  TIMEOUT: 'E_TIMEOUT',
  CANCELLED: 'E_CANCELLED',
  NETWORK: 'E_NETWORK',
  MALFORMED_RESPONSE: 'E_MALFORMED_RESPONSE',
  PROVIDER: 'E_PROVIDER',
  NOT_FOUND: 'E_NOT_FOUND',
  PERMISSION: 'E_PERMISSION',
  PATH_ESCAPE: 'E_PATH_ESCAPE',
  CONTEXT_TOO_LARGE: 'E_CONTEXT_TOO_LARGE',
  CAPACITY: 'E_CAPACITY',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type MeahErrorJson = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
  details?: Record<string, unknown>;
};

export class MeahError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      hint?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'MeahError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toJSON(): MeahErrorJson {
    const out: MeahErrorJson = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.hint) out.hint = this.hint;
    if (this.details) out.details = this.details;
    return out;
  }
}

/** Coerce anything thrown into a MeahError so tool output is always normalized. */
export function toMeahError(err: unknown): MeahError {
  if (err instanceof MeahError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new MeahError(ErrorCodes.CANCELLED, 'Operation was cancelled.', { cause: err });
    }
    return new MeahError(ErrorCodes.PROVIDER, err.message || 'Unknown error.', { cause: err });
  }
  return new MeahError(ErrorCodes.PROVIDER, `Unknown error: ${String(err)}`);
}
