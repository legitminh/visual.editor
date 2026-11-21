/**
 * Notework-style command syntax: `\name[arg, arg, key=value]`.
 *
 * - Arguments are separated by commas or newlines, so long commands can span lines.
 * - Brackets nest, so a command body may contain other commands (`\image_editor[\r[...]\v[...]]`).
 * - Values containing commas, brackets or newlines can be double-quoted; `\"` and `\\` escape inside quotes.
 */
export interface Arg { key?: string; value: string }
export interface Command { name: string; args: Arg[]; body: string; start: number; end: number }
export type Item = { type: 'command'; command: Command } | { type: 'text'; text: string };

const nameStart = /[A-Za-z_]/, nameChar = /[\w.]/;

/** Index just past the `]` matching the `[` at `open`, or -1 when unbalanced. */
function matchBracket(text: string, open: number) {
  let depth = 0, quoted = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i + 1;
  }
  return -1;
}

export function parseCommands(text: string): Item[] {
  const items: Item[] = [];
  let textStart = 0, i = 0;
  while (i < text.length) {
    if (text[i] !== '\\' || !nameStart.test(text[i + 1] ?? '')) { i++; continue; }
    let j = i + 1;
    while (j < text.length && nameChar.test(text[j])) j++;
    if (text[j] !== '[') { i = j; continue; }
    const end = matchBracket(text, j);
    if (end < 0) { i = j; continue; }
    if (i > textStart) items.push({ type: 'text', text: text.slice(textStart, i) });
    const body = text.slice(j + 1, end - 1);
    items.push({ type: 'command', command: { name: text.slice(i + 1, j), body, args: splitArgs(body), start: i, end } });
    i = textStart = end;
  }
  if (textStart < text.length) items.push({ type: 'text', text: text.slice(textStart) });
  return items;
}

function unquote(value: string) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return value;
}

export function splitArgs(body: string): Arg[] {
  const parts: string[] = [];
  let depth = 0, quoted = false, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (depth === 0 && (c === ',' || c === '\n')) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^([A-Za-z_][\w.-]*)\s*=\s*([\s\S]*)$/.exec(part);
    return match ? { key: match[1], value: unquote(match[2].trim()) } : { value: unquote(part) };
  });
}

/** Quote a value only when it would otherwise be split or misread. */
export function formatValue(value: string | number | boolean) {
  const text = String(value);
  return /[,\[\]\n"=]|^\s|\s$/.test(text) || text === '' ? `"${text.replace(/["\\]/g, '\\$&')}"` : text;
}

export function formatCommand(name: string, args: (string | number | [string, string | number | boolean])[], multiline = false) {
  const parts = args.map((arg) => Array.isArray(arg) ? `${arg[0]}=${formatValue(arg[1])}` : formatValue(arg));
  return multiline ? `\\${name}[\n${parts.map((part) => `  ${part}`).join('\n')}\n]` : `\\${name}[${parts.join(', ')}]`;
}

export const keyed = (args: Arg[]) => Object.fromEntries(args.filter((arg) => arg.key).map((arg) => [arg.key!.toLowerCase(), arg.value]));
export const positional = (args: Arg[]) => args.filter((arg) => !arg.key).map((arg) => arg.value);

export function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return !/^(false|no|off|0|hidden)$/i.test(value.trim());
}
export function parseNumber(value: string | undefined, fallback: number, min = -Infinity, max = Infinity) {
  const number = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
