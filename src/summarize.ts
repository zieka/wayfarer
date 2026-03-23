const MAX_INPUT_LENGTH = 300;

interface ObservationInput {
  tool_name: string;
  tool_input: string;
  tool_output: string;
}

export interface SummaryResult {
  summary: string;
  files_read: string | null;
  files_edited: string | null;
}

export function formatObservations(prompt: string | null, observations: ObservationInput[]): string {
  const lines = observations.map((obs, i) => {
    const input = obs.tool_input.length > MAX_INPUT_LENGTH
      ? obs.tool_input.slice(0, MAX_INPUT_LENGTH) + '...'
      : obs.tool_input;
    return `${i + 1}. [${obs.tool_name}] ${input}`;
  });

  const header = prompt ? `Session prompt: "${prompt}"\n\n` : '';
  return header + lines.join('\n');
}

export function parseSummaryResponse(text: string): SummaryResult {
  try {
    const parsed = JSON.parse(text);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : text,
      files_read: Array.isArray(parsed.files_read) ? parsed.files_read.join(',') : null,
      files_edited: Array.isArray(parsed.files_edited) ? parsed.files_edited.join(',') : null,
    };
  } catch {
    return { summary: text, files_read: null, files_edited: null };
  }
}

