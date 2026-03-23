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
  const reader = Bun.stdin.stream().getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = new TextDecoder().decode(value);
      chunks.push(text);
      // Try parsing after each chunk — Claude Code doesn't close stdin
      const result = parseStdin(chunks.join(''));
      if (result) return result;
    }
  } catch {
    // stdin closed or errored
  }

  return parseStdin(chunks.join(''));
}
