const DEFAULT_COMPRESS_THRESHOLD = 2048;
const DEFAULT_ORIGINALS_TTL_DAYS = 14;

export const HEAD_LINES = 40;
export const TAIL_LINES = 15;
export const CONTEXT_LINES = 10;
export const SUMMARY_LINES = 10;
export const MAX_SIGNAL_LINES = 100;
export const MAX_COMPRESSED_CHARS = 4096;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getCompressThreshold(): number {
  return envInt('WAYFARER_COMPRESS_THRESHOLD', DEFAULT_COMPRESS_THRESHOLD);
}

export function getOriginalsTtlDays(): number {
  return envInt('WAYFARER_ORIGINALS_TTL_DAYS', DEFAULT_ORIGINALS_TTL_DAYS);
}

export function hardTruncate(text: string): string {
  if (text.length <= MAX_COMPRESSED_CHARS) return text;
  const dropped = text.length - MAX_COMPRESSED_CHARS;
  return text.slice(0, MAX_COMPRESSED_CHARS) + `\n… [wayfarer: dropped ${dropped} chars] …`;
}

export function compressGeneric(text: string): string {
  const lines = text.split('\n');
  if (lines.length > HEAD_LINES + TAIL_LINES + 1) {
    const head = lines.slice(0, HEAD_LINES).join('\n');
    const tail = lines.slice(lines.length - TAIL_LINES).join('\n');
    const droppedLines = lines.length - HEAD_LINES - TAIL_LINES;
    const marker = `… [wayfarer: dropped ${droppedLines} lines] …`;
    const full = `${head}\n${marker}\n${tail}`;
    if (full.length <= MAX_COMPRESSED_CHARS) return full;
    // Over cap: budget head and tail independently so BOTH survive (front of
    // head, end of tail). Never front-slice the whole thing — that drops the tail.
    const budget = Math.max(0, MAX_COMPRESSED_CHARS - marker.length - 2);
    const half = Math.floor(budget / 2);
    const headPart = head.length > half ? head.slice(0, half) : head;
    const tailPart = tail.length > half ? tail.slice(tail.length - half) : tail;
    return `${headPart}\n${marker}\n${tailPart}`;
  }
  // Few lines (e.g. one giant line) but over threshold by char count.
  return hardTruncate(text);
}
