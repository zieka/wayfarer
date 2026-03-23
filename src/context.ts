import { getDb } from './db';

const MAX_RESULTS = 20;
const MAX_SNIPPET_LENGTH = 200;

function formatTimeAgo(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

interface ObservationRow {
  id: number;
  tool_name: string;
  tool_input: string;
  files_touched: string | null;
  created_at: number;
  context?: string;
}

interface SummaryRow {
  summary: string;
  files_read: string | null;
  files_edited: string | null;
  created_at: number;
}

function buildSummaryContext(rows: SummaryRow[]): string {
  const header = '## Recent work in this project\n\n';
  const blocks = rows.map((row) => {
    const time = formatTimeAgo(row.created_at);
    const files = [row.files_read, row.files_edited]
      .filter(Boolean)
      .join(',')
      .split(',')
      .filter((f, i, arr) => f && arr.indexOf(f) === i)
      .join(', ');
    const filesLine = files ? `\nFiles: ${files}` : '';
    return `**${time}:** ${row.summary}${filesLine}`;
  }).join('\n\n');

  return `<wayfarer-context>\n${header}${blocks}\n</wayfarer-context>`;
}

export function buildContext(
  project: string,
  query: string | undefined,
  dbPath?: string,
): string | null {
  const db = getDb(dbPath);
  try {
    // Try summaries first (unless we have a specific search query)
    if (!query) {
      const summaries = db.query(`
        SELECT summary, files_read, files_edited, created_at
        FROM session_summaries
        WHERE project = ?
        ORDER BY created_at DESC
        LIMIT 20
      `).all(project) as SummaryRow[];

      if (summaries.length > 0) {
        return buildSummaryContext(summaries);
      }
    }

    // Fall back to raw observations
    let rows: ObservationRow[];

    if (query) {
      const now = Math.floor(Date.now() / 1000);
      rows = db.query(`
        SELECT o.id, o.tool_name, o.files_touched, o.created_at,
               snippet(observations_fts, 1, '', '', '...', 32) as context
        FROM observations_fts
        JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ?
          AND o.project = ?
        ORDER BY (rank * -1.0) * (1.0 / (1.0 + (? - o.created_at) / 86400.0)) DESC
        LIMIT ?
      `).all(query, project, now, MAX_RESULTS) as ObservationRow[];
    } else {
      rows = db.query(`
        SELECT id, tool_name, tool_input, files_touched, created_at
        FROM observations
        WHERE project = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).all(project) as ObservationRow[];
    }

    if (rows.length === 0) return null;

    const header = '## Recent relevant work in this project\n\n| Time | Tool | Files | Context |\n|------|------|-------|---------|\n';
    const tableRows = rows.map((row) => {
      const time = formatTimeAgo(row.created_at);
      const files = row.files_touched ?? '';
      const context = truncate(row.context ?? row.tool_input ?? '', MAX_SNIPPET_LENGTH);
      return `| ${time} | ${row.tool_name} | ${files} | ${context} |`;
    }).join('\n');

    return `<wayfarer-context>\n${header}${tableRows}\n</wayfarer-context>`;
  } finally {
    db.close();
  }
}

interface EmbeddingRow {
  summary_id: number;
  embedding: Buffer;
  summary: string;
  files_read: string | null;
  files_edited: string | null;
  created_at: number;
  project: string;
}

export async function vectorSearch(
  query: string,
  project: string,
  dbPath?: string,
): Promise<string | null> {
  const { getEmbedding, cosineSimilarity } = await import('./embed');
  const queryEmbedding = await getEmbedding(query);

  const db = getDb(dbPath);
  try {
    const rows = db.query(`
      SELECT e.summary_id, e.embedding, s.summary, s.files_read, s.files_edited, s.created_at, s.project
      FROM summary_embeddings e
      JOIN session_summaries s ON s.id = e.summary_id
      WHERE s.project = ?
    `).all(project) as EmbeddingRow[];

    if (rows.length === 0) return null;

    const scored = rows.map((row) => {
      const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      return { ...row, score: cosineSimilarity(queryEmbedding, embedding) };
    }).sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);

    if (scored[0].score < 0.3) return null;

    return buildSummaryContext(scored);
  } finally {
    db.close();
  }
}
