import { ITEM_KINDS, ORGANIZE_RESULT_SCHEMA, type Item, type OrganizeResult } from '../types.js';
import { LlmError, type LlmAdapter } from './adapter.js';

/**
 * Long enough for a real meeting transcript, short enough that one runaway
 * capture cannot quietly cost a fortune.
 */
export const MAX_CONTENT_CHARS = 24_000;

export const ORGANIZER_SYSTEM_PROMPT = `You organize captures for a personal knowledge app. You are given one captured item — typed text, or a speech transcript — and you return metadata describing it.

Output exactly ONE raw JSON object. No prose, no explanation, no markdown code fences.

Shape:
{
  "lang": string,        // BCP-47 primary subtag of the content: "ko", "en", "ja", "zh", ... Use "und" if unclear.
  "kind": string,        // one of: ${ITEM_KINDS.join(', ')}
  "title": string,       // specific concrete noun phrase, <= 60 characters
  "summary": string,     // 1-3 sentences
  "tags": string[],      // 3-6 topical tags
  "keywords": string[],  // 3-8 ENGLISH keywords
  "people": string[],    // named people who appear in the content
  "tasks": [{ "text": string, "due"?: "YYYY-MM-DD", "owner"?: string }],
  "highlights": string[] // <= 3 verbatim excerpts worth keeping
}

Language rules — this vault is multilingual:
- Write "title", "summary", "tags", "people", "tasks" and "highlights" in the SAME language as the content. Never translate them.
- "keywords" is the single exception: always English, so that content in any language is reachable from an English query.

Content rules:
- "title" must describe what this specific item is about. Never a generic label such as "Note", "메모", "Meeting", or a restatement of the kind.
- "summary" states what the content actually says. Do not open with filler like "This note discusses" or "이 메모는".
- "tasks" holds only genuine action items the author has to act on. Return [] when there are none — do not invent them. Resolve relative dates ("내일", "next Friday") against the capture time given in the prompt; omit "due" when no date is implied.
- "highlights" are quoted verbatim from the content, unedited.
- Speech transcripts contain recognition errors, filler and false starts. Read through them for intent; never reproduce disfluencies.
- Judge only from the content. Do not add facts that are not there.`;

export interface OrganizeInput {
  body: string;
  capturedAt: string;
  source: Item['source'];
  sourceRef?: string;
  /** Language detected by the transcriber, used as a hint only. */
  languageHint?: string;
  /** The user's own names and terms, for repairing misheard spellings. */
  dictionary?: string[];
}

export function buildOrganizePrompt(input: OrganizeInput): string {
  const truncated = truncate(input.body, MAX_CONTENT_CHARS);
  const header = [
    `Captured at: ${input.capturedAt}`,
    `Source: ${input.source}`,
    input.sourceRef ? `Origin: ${input.sourceRef}` : undefined,
    input.languageHint ? `Detected language (hint only): ${input.languageHint}` : undefined,
    truncated.truncated ? `Note: content truncated to the first ${MAX_CONTENT_CHARS} characters.` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  // Placed after the content so the model reads it as a correction pass over
  // what it just saw, not as a topic to write about.
  const glossary = input.dictionary?.length
    ? `\n\n--- KNOWN TERMS ---\n${input.dictionary.join(', ')}\n` +
      'These are the author\'s own names, products and jargon. Where the content contains something that is clearly a misheard rendering of one of them, use the correct form in the fields you produce. Leave "highlights" quoted verbatim from the content, uncorrected. Do not force a term in where the content does not support it.'
    : '';

  return `${header}\n\n--- CONTENT ---\n${truncated.text}\n--- END CONTENT ---${glossary}\n\nReturn the JSON object now.`;
}

export interface OrganizeOutcome {
  result: OrganizeResult;
  model: string;
  costUsd: number;
  durationMs: number;
}

export async function organize(adapter: LlmAdapter, input: OrganizeInput): Promise<OrganizeOutcome> {
  const prompt = buildOrganizePrompt(input);

  let response = await adapter.complete({ system: ORGANIZER_SYSTEM_PROMPT, prompt });
  let parsed = tryParse(response.text);
  let costUsd = response.costUsd;

  // One retry, because a stray sentence around the JSON is the common failure
  // and is cheap to correct.
  if (!parsed) {
    response = await adapter.complete({
      system: ORGANIZER_SYSTEM_PROMPT,
      prompt: `${prompt}\n\nYour previous reply was not valid JSON matching the required shape. Reply with the raw JSON object only.`,
    });
    costUsd += response.costUsd;
    parsed = tryParse(response.text);
  }

  if (!parsed) {
    throw new LlmError('정리 결과를 JSON으로 해석하지 못했습니다.', response.text.slice(0, 500));
  }

  return { result: parsed, model: response.model, costUsd, durationMs: response.durationMs };
}

function tryParse(text: string): OrganizeResult | undefined {
  const candidate = extractJsonObject(text);
  if (!candidate) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return undefined;
  }

  const parsed = ORGANIZE_RESULT_SCHEMA.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Pulls the JSON object out of a reply that may be fenced or padded with prose. */
export function extractJsonObject(text: string): string | undefined {
  const withoutFence = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  return withoutFence.slice(start, end + 1);
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
