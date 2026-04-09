/**
 * layers.ts — 4-Layer Memory Stack for mempalace
 *
 * Direct port of mempalace/layers.py.
 *
 *   Layer 0: Identity       (~100 tokens)  — Always loaded. "Who am I?"
 *   Layer 1: Essential Story (~500-800)     — Always loaded. Top moments from the palace.
 *   Layer 2: On-Demand      (~200-500 each) — Loaded when a topic/wing comes up.
 *   Layer 3: Deep Search    (unlimited)     — Full semantic search.
 *
 * Wake-up cost: ~600-900 tokens (L0+L1). Leaves 95%+ of context free.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStore } from './vector-store';
import type { VectorStore, DrawerMetadata } from './vector-store';
import { MempalaceConfig } from './config';

// ── Layer 0 — Identity ──────────────────────────────────────────────────────

class Layer0 {
  private _path: string;
  private _text: string | null = null;

  constructor(identityPath?: string) {
    this._path = identityPath || path.join(os.homedir(), '.mempalace', 'identity.txt');
  }

  render(): string {
    if (this._text !== null) return this._text;

    if (fs.existsSync(this._path)) {
      this._text = fs.readFileSync(this._path, 'utf-8').trim();
    } else {
      this._text = '## L0 — IDENTITY\nNo identity configured. Create ~/.mempalace/identity.txt';
    }
    return this._text;
  }

  tokenEstimate(): number {
    return Math.floor(this.render().length / 4);
  }
}

// ── Layer 1 — Essential Story ────────────────────────────────────────────────

class Layer1 {
  static MAX_DRAWERS = 15;
  static MAX_CHARS = 3200;

  private palacePath: string;
  private wing: string | undefined;

  constructor(palacePath?: string, wing?: string) {
    const cfg = new MempalaceConfig();
    this.palacePath = palacePath || cfg.palacePath;
    this.wing = wing;
  }

  generate(): string {
    let store: VectorStore;
    try {
      store = createStore(this.palacePath);
    } catch {
      return '## L1 — No palace found. Run: mempalace mine <dir>';
    }

    // Fetch all drawers in batches (same as Python: 500 per batch)
    const BATCH = 500;
    const allDocs: string[] = [];
    const allMetas: DrawerMetadata[] = [];
    let offset = 0;

    while (true) {
      const batch = store.get({
        where: this.wing ? { wing: this.wing } : undefined,
        limit: BATCH,
        offset,
      });
      if (batch.documents.length === 0) break;
      allDocs.push(...batch.documents);
      allMetas.push(...batch.metadatas);
      offset += batch.documents.length;
      if (batch.documents.length < BATCH) break;
    }

    store.close();

    if (allDocs.length === 0) return '## L1 — No memories yet.';

    // Score each drawer: prefer high importance (same keys as Python)
    const scored: Array<[number, DrawerMetadata, string]> = [];
    for (let i = 0; i < allDocs.length; i++) {
      let importance = 3;
      for (const key of ['importance', 'emotional_weight', 'weight'] as const) {
        const val = allMetas[i][key];
        if (val !== undefined && val !== null) {
          const num = Number(val);
          if (!isNaN(num)) { importance = num; break; }
        }
      }
      scored.push([importance, allMetas[i], allDocs[i]]);
    }

    // Sort by importance descending, take top N
    scored.sort((a, b) => b[0] - a[0]);
    const top = scored.slice(0, Layer1.MAX_DRAWERS);

    // Group by room
    const byRoom = new Map<string, Array<[number, DrawerMetadata, string]>>();
    for (const entry of top) {
      const room = (entry[1].room as string) || 'general';
      if (!byRoom.has(room)) byRoom.set(room, []);
      byRoom.get(room)!.push(entry);
    }

    // Build compact text
    const lines: string[] = ['## L1 — ESSENTIAL STORY'];
    let totalLen = 0;

    for (const [room, entries] of [...byRoom.entries()].sort()) {
      const roomLine = `\n[${room}]`;
      lines.push(roomLine);
      totalLen += roomLine.length;

      for (const [, meta, doc] of entries) {
        const source = meta.source_file ? path.basename(meta.source_file as string) : '';
        let snippet = doc.trim().replace(/\n/g, ' ');
        if (snippet.length > 200) snippet = snippet.slice(0, 197) + '...';

        let entryLine = `  - ${snippet}`;
        if (source) entryLine += `  (${source})`;

        if (totalLen + entryLine.length > Layer1.MAX_CHARS) {
          lines.push('  ... (more in L3 search)');
          return lines.join('\n');
        }

        lines.push(entryLine);
        totalLen += entryLine.length;
      }
    }

    return lines.join('\n');
  }
}

// ── Layer 2 — On-Demand ──────────────────────────────────────────────────────

class Layer2 {
  private palacePath: string;

  constructor(palacePath?: string) {
    const cfg = new MempalaceConfig();
    this.palacePath = palacePath || cfg.palacePath;
  }

  retrieve(wing?: string, room?: string, nResults = 10): string {
    let store: VectorStore;
    try {
      store = createStore(this.palacePath);
    } catch {
      return 'No palace found.';
    }

    let where: Record<string, unknown> | undefined;
    if (wing && room) {
      where = { $and: [{ wing }, { room }] };
    } else if (wing) {
      where = { wing };
    } else if (room) {
      where = { room };
    }

    const results = store.get({ where, limit: nResults });
    store.close();

    if (results.documents.length === 0) {
      const label = [wing && `wing=${wing}`, room && `room=${room}`].filter(Boolean).join(' ');
      return `No drawers found for ${label}.`;
    }

    const lines = [`## L2 — ON-DEMAND (${results.documents.length} drawers)`];
    for (let i = 0; i < results.documents.length; i++) {
      const roomName = (results.metadatas[i].room as string) || '?';
      const source = results.metadatas[i].source_file ? path.basename(results.metadatas[i].source_file as string) : '';
      let snippet = results.documents[i].trim().replace(/\n/g, ' ');
      if (snippet.length > 300) snippet = snippet.slice(0, 297) + '...';
      let entry = `  [${roomName}] ${snippet}`;
      if (source) entry += `  (${source})`;
      lines.push(entry);
    }

    return lines.join('\n');
  }
}

// ── Layer 3 — Deep Search ────────────────────────────────────────────────────

class Layer3 {
  private palacePath: string;

  constructor(palacePath?: string) {
    const cfg = new MempalaceConfig();
    this.palacePath = palacePath || cfg.palacePath;
  }

  async search(query: string, wing?: string, room?: string, nResults = 5): Promise<string> {
    let store: VectorStore;
    try {
      store = createStore(this.palacePath);
    } catch {
      return 'No palace found.';
    }

    let where: Record<string, unknown> | undefined;
    if (wing && room) {
      where = { $and: [{ wing }, { room }] };
    } else if (wing) {
      where = { wing };
    } else if (room) {
      where = { room };
    }

    const results = await store.query({ queryText: query, nResults, where });
    store.close();

    const docs = results.documents[0];
    const metas = results.metadatas[0];
    const dists = results.distances[0];

    if (docs.length === 0) return 'No results found.';

    const lines = [`## L3 — SEARCH RESULTS for "${query}"`];
    for (let i = 0; i < docs.length; i++) {
      const similarity = Math.round((1 - dists[i]) * 1000) / 1000;
      const wingName = (metas[i].wing as string) || '?';
      const roomName = (metas[i].room as string) || '?';
      const source = metas[i].source_file ? path.basename(metas[i].source_file as string) : '';

      let snippet = docs[i].trim().replace(/\n/g, ' ');
      if (snippet.length > 300) snippet = snippet.slice(0, 297) + '...';

      lines.push(`  [${i + 1}] ${wingName}/${roomName} (sim=${similarity})`);
      lines.push(`      ${snippet}`);
      if (source) lines.push(`      src: ${source}`);
    }

    return lines.join('\n');
  }

  async searchRaw(query: string, wing?: string, room?: string, nResults = 5): Promise<Array<{
    text: string; wing: string; room: string; sourceFile: string; similarity: number; metadata: DrawerMetadata;
  }>> {
    let store: VectorStore;
    try {
      store = createStore(this.palacePath);
    } catch {
      return [];
    }

    let where: Record<string, unknown> | undefined;
    if (wing && room) {
      where = { $and: [{ wing }, { room }] };
    } else if (wing) {
      where = { wing };
    } else if (room) {
      where = { room };
    }

    const results = await store.query({ queryText: query, nResults, where });
    store.close();

    return results.documents[0].map((doc, i) => ({
      text: doc,
      wing: (results.metadatas[0][i].wing as string) || 'unknown',
      room: (results.metadatas[0][i].room as string) || 'unknown',
      sourceFile: path.basename((results.metadatas[0][i].source_file as string) || '?'),
      similarity: Math.round((1 - results.distances[0][i]) * 1000) / 1000,
      metadata: results.metadatas[0][i],
    }));
  }
}

// ── MemoryStack — unified interface ──────────────────────────────────────────

export class MemoryStack {
  palacePath: string;
  identityPath: string;

  private l0: Layer0;
  private l1: Layer1;
  private l2: Layer2;
  private l3: Layer3;

  constructor(palacePath?: string, identityPath?: string) {
    const cfg = new MempalaceConfig();
    this.palacePath = palacePath || cfg.palacePath;
    this.identityPath = identityPath || path.join(os.homedir(), '.mempalace', 'identity.txt');

    this.l0 = new Layer0(this.identityPath);
    this.l1 = new Layer1(this.palacePath);
    this.l2 = new Layer2(this.palacePath);
    this.l3 = new Layer3(this.palacePath);
  }

  /**
   * Generate wake-up text: L0 (identity) + L1 (essential story).
   * Typically ~600-900 tokens. Inject into system prompt.
   */
  wakeUp(wing?: string): string {
    const parts: string[] = [];
    parts.push(this.l0.render());
    parts.push('');
    if (wing) this.l1 = new Layer1(this.palacePath, wing);
    parts.push(this.l1.generate());
    return parts.join('\n');
  }

  /** On-demand L2 retrieval filtered by wing/room. */
  recall(wing?: string, room?: string, nResults = 10): string {
    return this.l2.retrieve(wing, room, nResults);
  }

  /** Deep L3 semantic search. */
  async search(query: string, wing?: string, room?: string, nResults = 5): Promise<string> {
    return this.l3.search(query, wing, room, nResults);
  }

  /** Deep L3 search returning raw objects. */
  async searchRaw(query: string, wing?: string, room?: string, nResults = 5) {
    return this.l3.searchRaw(query, wing, room, nResults);
  }

  /** Status of all layers. */
  status(): Record<string, unknown> {
    let totalDrawers = 0;
    try {
      const store = createStore(this.palacePath);
      totalDrawers = store.count();
      store.close();
    } catch { /* no palace */ }

    return {
      palace_path: this.palacePath,
      L0_identity: {
        path: this.identityPath,
        exists: fs.existsSync(this.identityPath),
        tokens: this.l0.tokenEstimate(),
      },
      L1_essential: { description: 'Auto-generated from top palace drawers' },
      L2_on_demand: { description: 'Wing/room filtered retrieval' },
      L3_deep_search: { description: 'Full semantic search' },
      total_drawers: totalDrawers,
    };
  }
}
