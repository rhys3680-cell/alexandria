/**
 * How much the model is allowed to reach outside the prompt.
 *
 * Each step up costs real tokens, because every granted tool ships its schema
 * with the request. Measured on the same trivial prompt:
 *
 *   none      190 input tokens   $0.0013
 *   web     1,892 input tokens   $0.0120
 *   vault   3,240 input tokens   $0.0201
 *   workspace 4,159 input tokens $0.0250   (8,337 / $0.0501 with commands)
 *
 * For comparison, letting the CLI keep its full default tool set costs 26,676.
 */
export type ToolAccess = 'none' | 'web' | 'vault' | 'workspace';

export interface LlmRequest {
  system: string;
  prompt: string;
  model?: string;
  /** Defaults to 'none' — the organize pass must never pay for tools. */
  tools?: ToolAccess;
  /** Session id from a previous response, to continue that exchange. */
  resume?: string;
  /** Keep the session on disk so it can be resumed. Off by default. */
  persist?: boolean;
}

export interface LlmResponse {
  text: string;
  model: string;
  /** What this call would cost on API pricing. Zero-ish on a subscription plan. */
  costUsd: number;
  durationMs: number;
  /** Present when the session was persisted; pass back as `resume`. */
  sessionId?: string;
}

export interface LlmAdapter {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Emits text as it arrives. Resolves with the same result as `complete`. */
  stream(request: LlmRequest, onText: (chunk: string) => void): Promise<LlmResponse>;
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
