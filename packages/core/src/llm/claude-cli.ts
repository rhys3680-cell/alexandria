import type { LlmConfig } from '../config.js';
import { resolveCommand, run } from '../proc.js';
import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from './adapter.js';

const AGENT_NAME = 'organizer';

interface ClaudeEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  modelUsage?: Record<string, unknown>;
}

/**
 * Drives the user's own `claude` CLI in headless mode.
 *
 * The important detail is `--agents` + `--agent`: declaring an agent with
 * `tools: []` strips every tool schema from the request. Measured on this
 * machine that is ~194 input tokens per call instead of ~26,700 — a ~100x
 * difference in both cost and in how fast a subscription's usage limit burns.
 *
 * Auth comes from whatever the CLI already uses, so a subscription login works
 * with no API key. Deliberately avoids `--bare`, which would force API-key auth.
 */
export class ClaudeCliAdapter implements LlmAdapter {
  readonly name = 'claude-cli';

  constructor(private readonly config: LlmConfig) {}

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
    const resolved = resolveCommand(this.config.command);
    if (!resolved) {
      throw new LlmError(`'${this.config.command}' 실행 파일을 찾을 수 없습니다.`);
    }

    const model = request.model ?? this.config.model;
    const args = [
      ...resolved.prefixArgs,
      '--print',
      '--output-format',
      'json',
      '--model',
      model,
      '--effort',
      this.config.effort,
      // tools: [] is what keeps the request small. The agent's own prompt acts
      // as the system prompt, so passing --system-prompt as well is redundant.
      '--agents',
      JSON.stringify({
        [AGENT_NAME]: { description: 'Structured organizer', prompt: request.system, tools: [] },
      }),
      '--agent',
      AGENT_NAME,
      // Do not inherit the user's own settings, MCP servers, or skills: this is
      // a background call and must behave identically on every machine.
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
    ];
    if (this.config.maxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    }

    // The prompt goes on stdin, not argv: transcripts routinely blow past the
    // ~32k character command-line limit on Windows.
    const result = await run(resolved.file, args, {
      input: request.prompt,
      timeoutMs: this.config.timeoutMs,
    });

    if (result.timedOut) {
      throw new LlmError(`정리 호출이 ${Math.round(this.config.timeoutMs / 1000)}초 안에 끝나지 않았습니다.`);
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

    if (envelope.is_error || typeof envelope.result !== 'string') {
      throw new LlmError(`claude CLI 오류 (${envelope.subtype ?? 'unknown'})`, String(envelope.result ?? '').slice(0, 800));
    }

    return {
      text: envelope.result,
      model,
      costUsd: Number(envelope.total_cost_usd ?? 0),
      durationMs: Number(envelope.duration_ms ?? result.durationMs),
    };
  }
}
