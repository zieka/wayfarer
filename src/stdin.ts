export function parseStdin(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function readStdin(): Promise<Record<string, unknown> | null> {
  const chunks: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const reader = Bun.stdin.stream().getReader();

  try {
    const timeout = setTimeout(() => reader.cancel(), 5000);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
      const result = parseStdin(chunks.join(''));
      if (result) {
        clearTimeout(timeout);
        return result;
      }
    }
    clearTimeout(timeout);
  } catch {
    // stdin closed, cancelled, or errored
  }

  return parseStdin(chunks.join(''));
}
