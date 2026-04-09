/**
 * searcher.ts — Find anything. Exact words.
 *
 * Direct port of mempalace/searcher.py.
 * Semantic search against the palace.
 * Returns verbatim text — the actual words, never summaries.
 */

import * as path from 'path';
import { createStore } from './vector-store';
import type { VectorStore, WhereFilter } from './vector-store';
import { MempalaceConfig } from './config';

export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchError';
  }
}

/**
 * Programmatic search — returns structured results.
 * Used by the MCP server and other callers that need data.
 *
 * Equivalent to Python's search_memories().
 */
export async function searchMemories(
  query: string,
  palacePath?: string,
  wing?: string,
  room?: string,
  nResults = 5,
): Promise<{
  query: string;
  filters: { wing?: string; room?: string };
  results: Array<{
    text: string;
    wing: string;
    room: string;
    sourceFile: string;
    similarity: number;
  }>;
} | { error: string; hint?: string }> {
  const cfg = new MempalaceConfig();
  const palace = palacePath || cfg.palacePath;

  let store: VectorStore;
  try {
    store = createStore(palace);
  } catch (e) {
    return {
      error: 'No palace found',
      hint: 'Run: mempalace init <dir> && mempalace mine <dir>',
    };
  }

  // Build where filter (same logic as Python)
  let where: WhereFilter | undefined;
  if (wing && room) {
    where = { $and: [{ wing }, { room }] };
  } else if (wing) {
    where = { wing };
  } else if (room) {
    where = { room };
  }

  try {
    const results = await store.query({ queryText: query, nResults, where });
    store.close();

    const docs = results.documents[0];
    const metas = results.metadatas[0];
    const dists = results.distances[0];

    const hits = docs.map((doc, i) => ({
      text: doc,
      wing: (metas[i].wing as string) || 'unknown',
      room: (metas[i].room as string) || 'unknown',
      sourceFile: path.basename((metas[i].source_file as string) || '?'),
      similarity: Math.round((1 - dists[i]) * 1000) / 1000,
    }));

    return { query, filters: { wing, room }, results: hits };
  } catch (e) {
    store.close();
    return { error: `Search error: ${e}` };
  }
}

/**
 * Check if a drawer with similar content already exists.
 * Used for deduplication (equivalent to mempalace_check_duplicate MCP tool).
 */
export async function checkDuplicate(
  content: string,
  palacePath?: string,
  threshold = 0.9,
): Promise<{ isDuplicate: boolean; similarity: number; existingText?: string }> {
  const cfg = new MempalaceConfig();
  const palace = palacePath || cfg.palacePath;

  let store: VectorStore;
  try {
    store = createStore(palace);
  } catch {
    return { isDuplicate: false, similarity: 0 };
  }

  try {
    const results = await store.query({ queryText: content, nResults: 1 });
    store.close();

    if (results.documents[0].length === 0) {
      return { isDuplicate: false, similarity: 0 };
    }

    const similarity = 1 - results.distances[0][0];
    return {
      isDuplicate: similarity >= threshold,
      similarity: Math.round(similarity * 1000) / 1000,
      existingText: similarity >= threshold ? results.documents[0][0] : undefined,
    };
  } catch {
    store.close();
    return { isDuplicate: false, similarity: 0 };
  }
}
