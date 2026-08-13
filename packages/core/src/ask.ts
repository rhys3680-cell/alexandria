import type { ToolAccess } from './llm/adapter.js';
import type { Item } from './types.js';

/** How much of each context item is shown to the model. */
export const CONTEXT_CHARS_PER_ITEM = 1200;

export interface AskInput {
  prompt: string;
  /** Defaults to 'none'. Each level up costs real tokens — see ToolAccess. */
  tools?: ToolAccess;
  /** Vault items placed in front of the model as grounding. */
  context?: Item[];
  /** Session id from a previous answer, to continue that exchange. */
  resume?: string;
  /** When given, the answer streams through this instead of arriving at once. */
  onText?: (chunk: string) => void;
}

export interface AskResult {
  text: string;
  costUsd: number;
  durationMs: number;
  /** Pass back as `resume` to keep the conversation going. */
  sessionId?: string;
}

const BASE_RULES = `You are the assistant inside Alexandria, someone's personal archive of notes and recordings.

- Reply in the language the user wrote in.
- Be direct and concrete. No preamble, no restating the question.
- When vault items are provided, ground your answer in them and refer to them by their short id. If they do not contain the answer, say so plainly rather than guessing.
- Never invent details about the user's own notes, people or commitments.`;

const TOOL_RULES: Record<ToolAccess, string> = {
  none: '\n- You have no tools. Answer from the conversation and any provided items alone.',
  web: '\n- You can search and fetch the web. Cite each claim you take from a page with its URL. Prefer primary sources, and say when you could not verify something.',
  vault: '\n- You can read files inside the vault directory. The markdown files under items/ are the archive; frontmatter carries the derived metadata.',
};

export function buildAskSystemPrompt(tools: ToolAccess = 'none'): string {
  return BASE_RULES + TOOL_RULES[tools];
}

export function buildAskPrompt(input: AskInput): string {
  const parts: string[] = [];

  if (input.context?.length) {
    parts.push(`--- 보관소 항목 ${input.context.length}개 ---`);
    for (const item of input.context) {
      parts.push(formatContextItem(item));
    }
    parts.push('--- 항목 끝 ---\n');
  }
  parts.push(input.prompt);
  return parts.join('\n');
}

function formatContextItem(item: Item): string {
  const head = [
    `[${item.id.slice(-6)}] ${item.title ?? '(제목 없음)'}`,
    `날짜: ${item.created.slice(0, 10)}`,
    item.tags.length ? `태그: ${item.tags.join(', ')}` : undefined,
    item.people.length ? `인물: ${item.people.join(', ')}` : undefined,
    item.summary ? `요약: ${item.summary}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  const body = item.body.slice(0, CONTEXT_CHARS_PER_ITEM);
  const clipped = item.body.length > CONTEXT_CHARS_PER_ITEM ? '\n(이하 생략)' : '';
  return `${head}\n본문:\n${body}${clipped}\n`;
}

/**
 * An answer rendered as a vault item.
 *
 * Keeping the question with the answer is what makes it worth saving: six
 * months later the question is the part that explains why the note exists.
 */
export function formatAnswerForVault(question: string, answer: string): string {
  return `**질문**\n\n${question.trim()}\n\n**답변**\n\n${answer.trim()}`;
}
