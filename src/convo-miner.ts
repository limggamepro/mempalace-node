/**
 * convo-miner.ts — Mine conversations into the palace.
 *
 * Direct port of mempalace/convo_miner.py.
 *
 * Ingests chat exports (Claude Code, ChatGPT, Slack, plain text transcripts).
 * Normalizes format, chunks by exchange pair (Q+A = one unit), files to palace.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createStore } from './vector-store';
import type { VectorStore, DrawerMetadata } from './vector-store';
import { MempalaceConfig } from './config';
import { normalize } from './normalize';

// File types that might contain conversations
export const CONVO_EXTENSIONS = new Set(['.txt', '.md', '.json', '.jsonl']);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', '.mempalace', 'tool-results', 'memory',
]);

const MIN_CHUNK_SIZE = 30;

// ── Topic keywords for conversation room detection ───────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
  technical: ['code', 'python', 'function', 'bug', 'error', 'api', 'database', 'server', 'deploy', 'git', 'test', 'debug', 'refactor'],
  architecture: ['architecture', 'design', 'pattern', 'structure', 'schema', 'interface', 'module', 'component', 'service', 'layer'],
  planning: ['plan', 'roadmap', 'milestone', 'deadline', 'priority', 'sprint', 'backlog', 'scope', 'requirement', 'spec'],
  decisions: ['decided', 'chose', 'picked', 'switched', 'migrated', 'replaced', 'trade-off', 'alternative', 'option', 'approach'],
  problems: ['problem', 'issue', 'broken', 'failed', 'crash', 'stuck', 'workaround', 'fix', 'solved', 'resolved'],
};

// ── Exchange-pair chunking ───────────────────────────────────────────────────

export interface ConvoChunk {
  content: string;
  chunk_index: number;
  memory_type?: string;
}

/**
 * Chunk by exchange pair: one > turn + AI response = one unit.
 * Falls back to paragraph chunking if no > markers.
 */
export function chunkExchanges(content: string): ConvoChunk[] {
  const lines = content.split('\n');
  const quoteLines = lines.filter(l => l.trim().startsWith('>')).length;

  if (quoteLines >= 3) {
    return chunkByExchange(lines);
  }
  return chunkByParagraph(content);
}

function chunkByExchange(lines: string[]): ConvoChunk[] {
  const chunks: ConvoChunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('>')) {
      const userTurn = line.trim();
      i++;

      const aiLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim().startsWith('>') || nextLine.trim().startsWith('---')) break;
        if (nextLine.trim()) aiLines.push(nextLine.trim());
        i++;
      }

      const aiResponse = aiLines.slice(0, 8).join(' ');
      const content = aiResponse ? `${userTurn}\n${aiResponse}` : userTurn;

      if (content.trim().length > MIN_CHUNK_SIZE) {
        chunks.push({ content, chunk_index: chunks.length });
      }
    } else {
      i++;
    }
  }

  return chunks;
}

function chunkByParagraph(content: string): ConvoChunk[] {
  const chunks: ConvoChunk[] = [];
  const paragraphs = content.split('\n\n').map(p => p.trim()).filter(Boolean);

  // If no paragraph breaks and long content, chunk by line groups
  if (paragraphs.length <= 1 && content.split('\n').length > 20) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 25) {
      const group = lines.slice(i, i + 25).join('\n').trim();
      if (group.length > MIN_CHUNK_SIZE) {
        chunks.push({ content: group, chunk_index: chunks.length });
      }
    }
    return chunks;
  }

  for (const para of paragraphs) {
    if (para.length > MIN_CHUNK_SIZE) {
      chunks.push({ content: para, chunk_index: chunks.length });
    }
  }

  return chunks;
}

// ── Room detection ───────────────────────────────────────────────────────────

/** Score conversation content against topic keywords */
export function detectConvoRoom(content: string): string {
  const contentLower = content.slice(0, 3000).toLowerCase();
  const scores: Record<string, number> = {};

  for (const [room, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (contentLower.includes(kw)) score++;
    }
    if (score > 0) scores[room] = score;
  }

  if (Object.keys(scores).length > 0) {
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }
  return 'general';
}

// ── Scan for conversation files ──────────────────────────────────────────────

export function scanConvos(convoDir: string): string[] {
  const convoPath = path.resolve(convoDir);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else {
        if (entry.name.endsWith('.meta.json')) continue;
        if (CONVO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(convoPath);
  return files;
}

// ── Check if already mined (simpler than miner — no mtime) ──────────────────

function fileAlreadyMined(store: VectorStore, sourceFile: string): boolean {
  try {
    const results = store.get({ where: { source_file: sourceFile }, limit: 1 });
    return results.ids.length > 0;
  } catch {
    return false;
  }
}

// ── Mine conversations ──────────────────────────────────────────────────────

export async function mineConvos(options: {
  convoDir: string;
  palacePath: string;
  wing?: string;
  agent?: string;
  limit?: number;
  dryRun?: boolean;
  extractMode?: 'exchange' | 'general';
}): Promise<{ totalDrawers: number; filesProcessed: number; filesSkipped: number; roomCounts: Record<string, number> }> {
  const {
    convoDir, palacePath, agent = 'mempalace',
    limit = 0, dryRun = false, extractMode = 'exchange',
  } = options;

  const convoPath = path.resolve(convoDir);
  const wing = options.wing || path.basename(convoPath).toLowerCase().replace(/ /g, '_').replace(/-/g, '_');

  let files = scanConvos(convoDir);
  if (limit > 0) files = files.slice(0, limit);

  const store = dryRun ? null : createStore(palacePath);

  let totalDrawers = 0;
  let filesSkipped = 0;
  let filesProcessed = 0;
  const roomCounts: Record<string, number> = {};

  for (const filepath of files) {
    const sourceFile = filepath;

    // Skip if already filed
    if (!dryRun && store && fileAlreadyMined(store, sourceFile)) {
      filesSkipped++;
      continue;
    }

    // Normalize format
    let content: string;
    try {
      content = normalize(filepath);
    } catch {
      continue;
    }

    if (!content || content.trim().length < MIN_CHUNK_SIZE) continue;

    // Chunk
    const chunks = chunkExchanges(content);
    if (chunks.length === 0) continue;

    // Detect room
    const room = detectConvoRoom(content);

    if (dryRun) {
      totalDrawers += chunks.length;
      roomCounts[room] = (roomCounts[room] || 0) + 1;
      continue;
    }

    roomCounts[room] = (roomCounts[room] || 0) + 1;

    // File each chunk
    let drawersAdded = 0;
    for (const chunk of chunks) {
      const hash = crypto.createHash('md5').update(sourceFile + String(chunk.chunk_index)).digest('hex').slice(0, 16);
      const drawerId = `drawer_${wing}_${room}_${hash}`;

      const metadata: DrawerMetadata = {
        wing, room, source_file: sourceFile,
        chunk_index: chunk.chunk_index, added_by: agent,
        filed_at: new Date().toISOString(),
      };

      try {
        await store!.upsert(drawerId, chunk.content, metadata);
        drawersAdded++;
      } catch {
        // skip duplicates silently
      }
    }

    totalDrawers += drawersAdded;
    filesProcessed++;
  }

  store?.close();

  return { totalDrawers, filesProcessed, filesSkipped, roomCounts };
}
