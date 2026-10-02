/** The single normalized adapter interface every MEAH provider implements. */

export type ProviderRequest = {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  signal: AbortSignal;
};

export type ProviderResult = {
  text: string;
  model: string;
  provider: string;
  requestId: string | null;
  finishReason: 'stop' | 'length' | 'content_filter' | 'other' | 'unknown';
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  latencyMs: number;
  attempts: number;
};

export type Provider = {
  readonly name: string;
  readonly kind: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
};
