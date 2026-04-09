/**
 * embedder.ts — Configurable vector embedding for MemPalace.
 *
 * Supports multiple models:
 *   - multilingual: paraphrase-multilingual-MiniLM-L12-v2 (50+ languages, default)
 *   - english: all-MiniLM-L6-v2 (English-focused, original MemPalace default)
 *   - bge-m3: bge-m3 (best multilingual, includes dialects/classical Chinese)
 *
 * No API calls. No network after first model download.
 */

import { EMBEDDING_MODELS, EmbeddingModelKey } from './config';

// @xenova/transformers is ESM-only; we dynamic-import it
let pipeline: any = null;

// Cache extractors per model (so switching doesn't reload)
const extractors = new Map<string, any>();

// Currently active model
let activeModel: EmbeddingModelKey = 'multilingual';

/**
 * Set the active embedding model.
 * Call before any embed() calls, or at startup.
 */
export function setModel(model: EmbeddingModelKey): void {
  activeModel = model;
}

/** Get the current model key */
export function getModel(): EmbeddingModelKey {
  return activeModel;
}

/** Get the vector dimension for the current model */
export function getEmbeddingDim(): number {
  return EMBEDDING_MODELS[activeModel].dim;
}

async function getExtractor(): Promise<any> {
  const modelId = EMBEDDING_MODELS[activeModel].id;

  if (extractors.has(modelId)) return extractors.get(modelId);

  if (!pipeline) {
    // Disable sharp (optional image dep) to avoid native build issues
    process.env.TRANSFORMERS_JS_SHARP = '0';
    const mod = await import('@xenova/transformers');
    if (mod.env) {
      (mod.env as Record<string, unknown>).backends = { onnx: {} };
    }
    pipeline = mod.pipeline;
  }

  const ext = await pipeline('feature-extraction', modelId, { quantized: true });
  extractors.set(modelId, ext);
  return ext;
}

/**
 * Embed a single text string into a float vector.
 * Dimension depends on active model (384 or 1024).
 */
export async function embed(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Embed multiple texts in batch.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

/**
 * Cosine similarity between two vectors (number[] version, slower).
 * Since vectors are normalized (L2 norm = 1), this is just the dot product.
 *
 * Prefer cosineSimilarityF32 for hot paths — Float32Array is 3-5x faster
 * because it stores values in contiguous memory and avoids array boxing.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Cosine similarity between two Float32Arrays (fast path).
 * Identical math, but avoids the overhead of converting to number[].
 */
export function cosineSimilarityF32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Cosine distance (1 - similarity). Matches ChromaDB's distance metric.
 */
export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/** @deprecated Use getEmbeddingDim() instead — dimension varies by model */
export const EMBEDDING_DIM = 384;
