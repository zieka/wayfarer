import { EmbeddingModel, FlagEmbedding } from 'fastembed';

let model: FlagEmbedding | null = null;

export async function getEmbedding(text: string): Promise<Float32Array> {
  if (!model) {
    model = await FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15 });
  }
  const results = await model.embed([text]);
  for await (const batch of results) {
    return batch[0];
  }
  throw new Error('No embedding returned');
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
