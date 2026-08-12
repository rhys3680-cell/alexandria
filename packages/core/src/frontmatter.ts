import YAML from 'yaml';

export interface ParsedDocument {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): ParsedDocument {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const match = FENCE.exec(text);
  if (!match) return { data: {}, body: text };

  const parsed = YAML.parse(match[1] ?? '') as unknown;
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};

  return { data, body: text.slice(match[0].length) };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    clean[key] = value;
  }
  const yaml = YAML.stringify(clean, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}
