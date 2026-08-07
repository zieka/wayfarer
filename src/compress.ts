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

const LOG_SIGNAL_RE = /\b(ERROR|WARN(?:ING)?|FAIL(?:ED|URE)?|Traceback|Exception|panic)\b/;
const STACK_FRAME_RE = /^\s+at\s+/;

export function pickStrategy(toolName: string, text: string): 'log' | 'generic' {
  if (toolName === 'Bash' || toolName === 'BashOutput') return 'log';
  if (LOG_SIGNAL_RE.test(text)) return 'log';
  return 'generic';
}

function isSignal(line: string): boolean {
  return LOG_SIGNAL_RE.test(line) || STACK_FRAME_RE.test(line);
}

export function compressLog(text: string): string {
  const lines = text.split('\n');
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < Math.min(CONTEXT_LINES, lines.length); i++) keep[i] = true;
  for (let i = Math.max(0, lines.length - SUMMARY_LINES); i < lines.length; i++) keep[i] = true;
  let signalCount = 0;
  for (let i = 0; i < lines.length && signalCount < MAX_SIGNAL_LINES; i++) {
    if (isSignal(lines[i])) { keep[i] = true; signalCount++; }
  }
  const out: string[] = [];
  let droppedRun = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (droppedRun > 0) { out.push(`… [wayfarer: dropped ${droppedRun} lines] …`); droppedRun = 0; }
      out.push(lines[i]);
    } else {
      droppedRun++;
    }
  }
  if (droppedRun > 0) out.push(`… [wayfarer: dropped ${droppedRun} lines] …`);
  const result = out.join('\n');
  return result.length > MAX_COMPRESSED_CHARS ? hardTruncate(result) : result;
}

export function compressField(toolName: string, text: string): { text: string; compressed: boolean } {
  if (text.length <= getCompressThreshold()) return { text, compressed: false };
  try {
    const strategy = pickStrategy(toolName, text);
    const out = strategy === 'log' ? compressLog(text) : compressGeneric(text);
    if (out.length >= text.length) return { text, compressed: false };
    return { text: out, compressed: true };
  } catch {
    return { text: hardTruncate(text), compressed: true };
  }
}

export function compressForStorage(
  toolName: string,
  toolInput: string,
  toolOutput: string,
): { input: { text: string; compressed: boolean }; output: { text: string; compressed: boolean } } {
  return {
    input: compressField(toolName, toolInput),
    output: compressField(toolName, toolOutput),
  };
}
