import type { Database } from 'bun:sqlite';
import { COMPRESSION_MARKER_RE } from './compress';

export interface RetrievedField {
  text: string;
  expired: boolean; // true = was compressed but the original is gone (TTL-pruned)
}

export interface RetrieveResult {
  found: boolean;
  observationId: number;
  toolName?: string;
  createdAt?: number;
  input?: RetrievedField;
  output?: RetrievedField;
}

export function retrieveOriginal(db: Database, observationId: number): RetrieveResult {
  const obs = db.query(
    'SELECT tool_name, tool_input, tool_output, created_at FROM observations WHERE id = ?',
  ).get(observationId) as
    { tool_name: string; tool_input: string; tool_output: string; created_at: number } | null;
  if (!obs) return { found: false, observationId };

  const orig = db.query(
    'SELECT tool_input_full, tool_output_full FROM observation_originals WHERE observation_id = ?',
  ).get(observationId) as
    { tool_input_full: string | null; tool_output_full: string | null } | null;

  // Three-state resolution: preserved original → stored-with-marker (expired) → stored (never compressed).
  const resolve = (full: string | null | undefined, stored: string): RetrievedField => {
    if (full != null) return { text: full, expired: false };
    if (COMPRESSION_MARKER_RE.test(stored)) return { text: stored, expired: true };
    return { text: stored, expired: false };
  };

  return {
    found: true,
    observationId,
    toolName: obs.tool_name,
    createdAt: obs.created_at,
    input: resolve(orig?.tool_input_full, obs.tool_input),
    output: resolve(orig?.tool_output_full, obs.tool_output),
  };
}

export function formatRetrieveResult(r: RetrieveResult): string {
  if (!r.found) return `wayfarer-retrieve: no observation with id ${r.observationId}\n`;
  const when = new Date((r.createdAt ?? 0) * 1000).toISOString();
  const field = (label: string, f?: RetrievedField): string => {
    if (!f) return '';
    const note = f.expired ? ' (original expired — showing compressed form)' : '';
    return `### ${label}${note}\n${f.text}\n`;
  };
  return `## Observation #${r.observationId} — ${r.toolName} @ ${when}\n` +
    field('Input', r.input) + field('Output', r.output);
}
