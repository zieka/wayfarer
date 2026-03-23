const FILE_PATH_RE = /(?:\/[\w.-]+)+\.[\w]+|(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g;

export function extractFilePaths(input: string): string | null {
  const matches = input.match(FILE_PATH_RE);
  if (!matches || matches.length === 0) return null;
  const unique = [...new Set(matches)];
  return unique.join(',');
}
