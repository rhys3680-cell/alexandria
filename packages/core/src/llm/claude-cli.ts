import type { LlmConfig } from '../config.js';
import { resolveCommand, run, runStreaming, type ResolvedCommand } from '../proc.js';
import {
  LlmError,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponse,
  type ToolAccess,
} from './adapter.js';

const AGENT_NAME = 'organizer';

/**
 * Tools granted per access level. Deliberately narrow: the CLI's full set
 * costs 26,676 input tokens per call, and nothing here needs to write.
 */
const TOOL_SETS: Record<ToolAccess, string[]> = {
  none: [],
  web: ['WebSearch', 'WebFetch'],
  vault: ['Read', 'Glob', 'Grep'],
};

interface ClaudeEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
}

/**
 * Drives the user's own `claude` CLI in headless mode.
 *
 * The important detail is `--agents` + `--agent`: declaring an agent with an
 * explicit tool list strips every other tool schema from the request. With an
 * empty list that is ~194 input tokens per call instead of ~26,700 — a ~100x
 * difference in both cost and in how fast a subscription's usage limit burns.
 *
 * Auth comes from whatever the CLI already uses, so a subscription login works
 * with no API key. Deliberately avoids `--bare`, which would force API-key auth.
 */
export class ClaudeCliAdapter implements LlmAdapter {
  readonly name = 'claude-cli';

  constructor(
    private readonly config: LlmConfig,
    /** Granted as a readable directory when tool access is `vault`. */
    private readonly vaultDir?: string,
  ) {}

  async check(): Promise<string | null> {
    const resolved = resolveCommand(this.config.command);
    if (!resolved) {
      return `'${this.config.command}' 실행 파일을 PATH에서 찾지 못했습니다. Claude Code를 설치하세요: npm i -g @anthropic-ai/claude-code`;
    }
    try {
      const result = await run(resolved.file, [...resolved.prefixArgs, '--version'], { timeoutMs: 20_000 });
      if (result.code !== 0) {
        return `'${this.config.command} --version' 이 실패했습니다: ${(result.stderr || result.stdout).trim().slice(0, 200)}`;
      }
    } catch (error) {
      return `'${resolved.file}' 을 실행할 수 없습니다: ${(error as Error).message}`;
    }
    return null;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const { resolved, args, model } = this.buildArgs(request, false);

    const result = await run(resolved.file, args, {
      input: request.prompt,
      timeoutMs: this.config.timeoutMs,
    });

    if (result.timedOut) {
      throw new LlmError(`호출이 ${Math.round(this.config.timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
    }
    if (result.code !== 0) {
      throw new LlmError('claude CLI 호출이 실패했습니다.', (result.stderr || result.stdout).trim().slice(0, 800));
    }

    let envelope: ClaudeEnvelope;
    try {
      envelope = JSON.parse(result.stdout) as ClaudeEnvelope;
    } catch {
      throw new LlmError('claude CLI 응답을 JSON으로 해석할 수 없습니다.', result.stdout.slice(0, 800));
    }
    return this.toResponse(envelope, model, result.durationMs);
  }

  async stream(request: LlmRequest, onText: (chunk: string) => void): Promise<LlmResponse> {
    const { resolved, args, model } = this.buildArgs(request, true);

    let envelope: ClaudeEnvelope | undefined;
    const result = await runStreaming(resolved.file, args, {
      input: request.prompt,
      timeoutMs: this.config.timeoutMs,
      onLine: (line) => {
        let event: { type?: string; event?: { type?: string; delta?: { text?: string } } } & ClaudeEnvelope;
        try {
          event = JSON.parse(line);
        } catch {
          return; // Non-JSON noise on stdout is not worth failing the stream over.
        }
        if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
          const text = event.event.delta?.text;
          if (text) onText(text);
        } else if (event.type === 'result') {
          envelope = event;
        }
      },
    });

    if (result.timedOut) {
      throw new LlmError(`호출이 ${Math.round(this.config.timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
    }
    if (result.code !== 0) {
      throw new LlmError('claude CLI 호출이 실패했습니다.', result.stderr.trim().slice(0, 800));
    }
    if (!envelope) {
      throw new LlmError('스트림이 결과 없이 끝났습니다.', result.stderr.slice(0, 800));
    }
    return this.toResponse(envelope, model, result.durationMs);
  }

  private toResponse(envelope: ClaudeEnvelope, model: string, fallbackMs: number): LlmResponse {
    if (envelope.is_error || typeof envelope.result !== 'string') {
      throw new LlmError(
        `claude CLI 오류 (${envelope.subtype ?? 'unknown'})`,
        String(envelope.result ?? '').slice(0, 800),
      );
    }
    return {
      text: envelope.result,
      model,
      costUsd: Number(envelope.total_cost_usd ?? 0),
      durationMs: Number(envelope.duration_ms ?? fallbackMs),
      sessionId: envelope.session_id,
    };
  }

  private buildArgs(
    request: LlmRequest,
    streaming: boolean,
  ): { resolved: ResolvedCommand; args: string[]; model: string } {
    const resolved = resolveCommand(this.config.command);
    if (!resolved) {
      throw new LlmError(`'${this.config.command}' 실행 파일을 찾을 수 없습니다.`);
    }

    const model = request.model ?? this.config.model;
    const access: ToolAccess = request.tools ?? 'none';
    const tools = TOOL_SETS[access];

    const args = [...resolved.prefixArgs, '--print'];

    if (streaming) {
      // stream-json is rejected without --verbose when combined with --print.
      args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
    } else {
      args.push('--output-format', 'json');
    }

    args.push(
      '--model',
      model,
      '--effort',
      this.config.effort,
      // The agent's own prompt acts as the system prompt, and its tool list is
      // what keeps the request small.
      '--agents',
      JSON.stringify({
        [AGENT_NAME]: { description: 'Alexandria', prompt: request.system, tools },
      }),
      '--agent',
      AGENT_NAME,
      // Do not inherit the user's own settings, MCP servers, or skills: this
      // must behave identically on every machine.
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
    );

    // Declaring a tool on the agent is not enough: without an explicit
    // permission the CLI denies it silently in non-interactive mode, and the
    // model answers that it "has no web access".
    if (tools.length) args.push('--allowedTools', tools.join(' '));
    if (access === 'vault' && this.vaultDir) args.push('--add-dir', this.vaultDir);
    if (request.resume) args.push('--resume', request.resume);
    // Sessions are only kept when something intends to resume them.
    if (!request.persist && !request.resume) args.push('--no-session-persistence');
    if (this.config.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    }

    return { resolved, args, model };
  }
}
