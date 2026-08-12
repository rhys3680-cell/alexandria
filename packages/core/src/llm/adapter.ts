export interface LlmRequest {
  system: string;
  prompt: string;
  model?: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  /** What this call would cost on API pricing. Zero-ish on a subscription plan. */
  costUsd: number;
  durationMs: number;
}

export interface LlmAdapter {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Human-readable reason the adapter cannot run, or null when it is ready. */
  check(): Promise<string | null>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
