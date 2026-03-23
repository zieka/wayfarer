import { getSettings, DEFAULT_MODEL } from './settings';

const SYSTEM_PROMPT = `You are a concise technical summarizer. Given a list of tool observations from a coding session, produce a JSON response with three fields:
- "summary": 2-3 sentence narrative of what was accomplished
- "files_read": array of file paths that were read
- "files_edited": array of file paths that were created or modified

Focus on what changed and why, not the mechanics of each tool call. Respond with only the JSON object, no markdown fencing.`;

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

export async function callAnthropic(content: string, model?: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const selectedModel = model ?? getSettings().model;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}
