/**
 * miner.ts — Files everything into the palace.
 *
 * Direct port of mempalace/miner.py.
 * Reads mempalace.yaml from project directory for wing + rooms.
 * Routes each file to the right room based on content.
 * Stores verbatim chunks as drawers. No summaries. Ever.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createStore } from './vector-store';
import type { VectorStore, DrawerMetadata } from './vector-store';
import { MempalaceConfig } from './config';

// ── Constants (identical to Python) ──────────────────────────────────────────

export const READABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.js', '.ts', '.jsx', '.tsx', '.json',
  '.yaml', '.yml', '.html', '.css', '.java', '.go', '.rs',
  '.rb', '.sh', '.csv', '.sql', '.toml',
]);

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', 'coverage', '.mempalace', '.ruff_cache',
  '.mypy_cache', '.pytest_cache', '.cache', '.tox', '.nox',
  '.idea', '.vscode', '.ipynb_checkpoints', '.eggs', 'htmlcov', 'target',
]);

export const SKIP_FILENAMES = new Set([
  'mempalace.yaml', 'mempalace.yml', 'mempal.yaml', 'mempal.yml',
  '.gitignore', 'package-lock.json',
]);

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;
export const MIN_CHUNK_SIZE = 50;

// ── Gitignore matcher (port of Python GitignoreMatcher) ──────────────────────

interface GitignoreRule {
  pattern: string;
  anchored: boolean;
  dirOnly: boolean;
  negated: boolean;
}

export class GitignoreMatcher {
  baseDir: string;
  rules: GitignoreRule[];

  constructor(baseDir: string, rules: GitignoreRule[]) {
    this.baseDir = baseDir;
    this.rules = rules;
  }

  static fromDir(dirPath: string): GitignoreMatcher | null {
    const gitignorePath = path.join(dirPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return null;

    let lines: string[];
    try {
      lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');
    } catch {
      return null;
    }

    const rules: GitignoreRule[] = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (line.startsWith('\\#') || line.startsWith('\\!')) {
        line = line.slice(1);
      } else if (line.startsWith('#')) {
        continue;
      }

      const negated = line.startsWith('!');
      if (negated) line = line.slice(1);

      const anchored = line.startsWith('/');
      if (anchored) line = line.replace(/^\/+/, '');

      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.replace(/\/+$/, '');

      if (!line) continue;

      rules.push({ pattern: line, anchored, dirOnly, negated });
    }

    return rules.length > 0 ? new GitignoreMatcher(dirPath, rules) : null;
  }

  matches(filePath: string, isDir = false): boolean | null {
    const relative = path.relative(this.baseDir, filePath).split(path.sep).join('/');
    if (!relative || relative.startsWith('..')) return null;

    let ignored: boolean | null = null;
    for (const rule of this.rules) {
      if (this._ruleMatches(rule, relative, isDir)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  private _ruleMatches(rule: GitignoreRule, relative: string, isDir: boolean): boolean {
    const parts = relative.split('/');
    const patternParts = rule.pattern.split('/');

    if (rule.dirOnly) {
      const targetParts = isDir ? parts : parts.slice(0, -1);
      if (targetParts.length === 0) return false;
      if (rule.anchored || patternParts.length > 1) {
        return this._matchFromRoot(targetParts, patternParts);
      }
      return targetParts.some(part => this._fnmatch(part, rule.pattern));
    }

    if (rule.anchored || patternParts.length > 1) {
      return this._matchFromRoot(parts, patternParts);
    }

    return parts.some(part => this._fnmatch(part, rule.pattern));
  }

  private _matchFromRoot(targetParts: string[], patternParts: string[]): boolean {
    const matches = (pi: number, ppi: number): boolean => {
      if (ppi === patternParts.length) return true;
      if (pi === targetParts.length) {
        return patternParts.slice(ppi).every(p => p === '**');
      }
      if (patternParts[ppi] === '**') {
        return matches(pi, ppi + 1) || matches(pi + 1, ppi);
      }
      if (!this._fnmatch(targetParts[pi], patternParts[ppi])) return false;
      return matches(pi + 1, ppi + 1);
    };
    return matches(0, 0);
  }

  /** Simple glob match (supports * and ?) */
  private _fnmatch(name: string, pattern: string): boolean {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(name);
  }
}

// ── File routing ─────────────────────────────────────────────────────────────

export interface RoomConfig {
  name: string;
  description?: string;
  keywords?: string[];
}

/**
 * Route a file to the right room.
 * Priority: folder path > filename > content keywords > "general"
 * (Identical logic to Python detect_room)
 */
export function detectRoom(
  filepath: string,
  content: string,
  rooms: RoomConfig[],
  projectPath: string,
): string {
  const relative = path.relative(projectPath, filepath).toLowerCase();
  const filename = path.basename(filepath, path.extname(filepath)).toLowerCase();
  const contentLower = content.slice(0, 2000).toLowerCase();

  // Priority 1: folder path matches room name or keywords
  const pathParts = relative.replace(/\\/g, '/').split('/');
  for (const part of pathParts.slice(0, -1)) { // skip filename itself
    for (const room of rooms) {
      const candidates = [room.name.toLowerCase(), ...(room.keywords || []).map(k => k.toLowerCase())];
      if (candidates.some(c => part === c || c.includes(part) || part.includes(c))) {
        return room.name;
      }
    }
  }

  // Priority 2: filename matches room name
  for (const room of rooms) {
    if (room.name.toLowerCase().includes(filename) || filename.includes(room.name.toLowerCase())) {
      return room.name;
    }
  }

  // Priority 3: keyword scoring
  const scores: Record<string, number> = {};
  for (const room of rooms) {
    const keywords = [...(room.keywords || []), room.name];
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      let idx = 0;
      while ((idx = contentLower.indexOf(kwLower, idx)) !== -1) {
        score++;
        idx += kwLower.length;
      }
    }
    scores[room.name] = score;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return best[0];

  return 'general';
}

// ── Chunking (identical to Python) ───────────────────────────────────────────

export interface Chunk {
  content: string;
  chunkIndex: number;
}

/**
 * Split content into drawer-sized chunks.
 * Tries to split on paragraph/line boundaries.
 * 800 chars per chunk, 100 char overlap, min 50 chars.
 */
export function chunkText(content: string): Chunk[] {
  content = content.trim();
  if (!content) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < content.length) {
    let end = Math.min(start + CHUNK_SIZE, content.length);

    // Try to break at paragraph boundary
    if (end < content.length) {
      const doubleNewline = content.lastIndexOf('\n\n', end);
      if (doubleNewline > start + CHUNK_SIZE / 2) {
        end = doubleNewline;
      } else {
        const singleNewline = content.lastIndexOf('\n', end);
        if (singleNewline > start + CHUNK_SIZE / 2) {
          end = singleNewline;
        }
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk.length >= MIN_CHUNK_SIZE) {
      chunks.push({ content: chunk, chunkIndex });
      chunkIndex++;
    }

    start = end < content.length ? end - CHUNK_OVERLAP : end;
  }

  return chunks;
}

// ── File scanning ────────────────────────────────────────────────────────────

/**
 * Scan a project directory for readable files.
 * Respects .gitignore rules. Skips known build/cache dirs.
 */
export function scanProject(
  projectDir: string,
  respectGitignore = true,
  includeIgnored?: string[],
): string[] {
  const projectPath = path.resolve(projectDir);
  const files: string[] = [];
  const matcherCache = new Map<string, GitignoreMatcher | null>();
  const includePaths = new Set((includeIgnored || []).map(p => p.trim().replace(/^\/+|\/+$/g, '')));

  function isForceIncluded(filePath: string): boolean {
    if (includePaths.size === 0) return false;
    const relative = path.relative(projectPath, filePath).split(path.sep).join('/');
    for (const inc of includePaths) {
      if (relative === inc || relative.startsWith(inc + '/') || inc.startsWith(relative + '/')) {
        return true;
      }
    }
    return false;
  }

  function walk(dir: string, activeMatchers: GitignoreMatcher[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Load gitignore for this directory
    if (respectGitignore) {
      if (!matcherCache.has(dir)) {
        matcherCache.set(dir, GitignoreMatcher.fromDir(dir));
      }
      const matcher = matcherCache.get(dir);
      if (matcher) {
        activeMatchers = [...activeMatchers, matcher];
      }
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!isForceIncluded(fullPath) && SKIP_DIRS.has(entry.name)) continue;
        if (respectGitignore && activeMatchers.length > 0 && !isForceIncluded(fullPath)) {
          let ignored = false;
          for (const m of activeMatchers) {
            const decision = m.matches(fullPath, true);
            if (decision !== null) ignored = decision;
          }
          if (ignored) continue;
        }
        walk(fullPath, activeMatchers);
      } else {
        if (!isForceIncluded(fullPath) && SKIP_FILENAMES.has(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!READABLE_EXTENSIONS.has(ext) && !isForceIncluded(fullPath)) continue;
        if (respectGitignore && activeMatchers.length > 0 && !isForceIncluded(fullPath)) {
          let ignored = false;
          for (const m of activeMatchers) {
            const decision = m.matches(fullPath, false);
            if (decision !== null) ignored = decision;
          }
          if (ignored) continue;
        }
        files.push(fullPath);
      }
    }
  }

  walk(projectPath, []);
  return files;
}

// ── Mining ───────────────────────────────────────────────────────────────────

/**
 * Mine a single file: read, chunk, route, store.
 * Returns [drawerCount, roomName].
 */
async function processFile(
  filepath: string,
  projectPath: string,
  store: VectorStore,
  wing: string,
  rooms: RoomConfig[],
  agent: string,
  dryRun: boolean,
): Promise<[number, string | null]> {
  // Skip if already filed and unchanged (mtime check)
  if (!dryRun) {
    const existing = store.get({ where: { source_file: filepath }, limit: 1 });
    if (existing.ids.length > 0) {
      const storedMtime = existing.metadatas[0]?.source_mtime;
      if (storedMtime !== undefined && storedMtime !== null) {
        try {
          const currentMtime = fs.statSync(filepath).mtimeMs / 1000;
          if (Number(storedMtime) === currentMtime) return [0, null]; // unchanged
        } catch { /* re-mine if stat fails */ }
      }
    }
  }

  let content: string;
  try {
    content = fs.readFileSync(filepath, 'utf-8');
  } catch {
    return [0, null];
  }

  content = content.trim();
  if (content.length < MIN_CHUNK_SIZE) return [0, null];

  const room = detectRoom(filepath, content, rooms, projectPath);
  const chunks = chunkText(content);

  if (dryRun) {
    return [chunks.length, room];
  }

  let drawersAdded = 0;
  for (const chunk of chunks) {
    const hash = crypto.createHash('md5').update(filepath + String(chunk.chunkIndex)).digest('hex').slice(0, 16);
    const drawerId = `drawer_${wing}_${room}_${hash}`;

    let mtime: number | undefined;
    try { mtime = fs.statSync(filepath).mtimeMs / 1000; } catch { /* ignore */ }

    const metadata: DrawerMetadata = {
      wing,
      room,
      source_file: filepath,
      chunk_index: chunk.chunkIndex,
      added_by: agent,
      filed_at: new Date().toISOString(),
      source_mtime: mtime,
    };

    await store.upsert(drawerId, chunk.content, metadata);
    drawersAdded++;
  }

  return [drawersAdded, room];
}

export interface MineConfig {
  wing: string;
  rooms: RoomConfig[];
}

/**
 * Load mempalace.yaml from a project directory.
 */
export function loadConfig(projectDir: string): MineConfig {
  const yamlPath = path.join(path.resolve(projectDir), 'mempalace.yaml');
  const legacyPath = path.join(path.resolve(projectDir), 'mempal.yaml');

  let configPath = yamlPath;
  if (!fs.existsSync(configPath)) {
    configPath = legacyPath;
    if (!fs.existsSync(configPath)) {
      throw new Error(`No mempalace.yaml found in ${projectDir}. Run: mempalace init ${projectDir}`);
    }
  }

  // Simple YAML parsing for our flat config format
  const content = fs.readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');
  let wing = '';
  const rooms: RoomConfig[] = [];
  let currentRoom: Partial<RoomConfig> | null = null;

  for (const line of lines) {
    const wingMatch = line.match(/^wing:\s*(.+)/);
    if (wingMatch) { wing = wingMatch[1].trim(); continue; }

    if (line.match(/^\s+-\s+name:\s*/)) {
      if (currentRoom?.name) rooms.push(currentRoom as RoomConfig);
      currentRoom = { name: line.replace(/^\s+-\s+name:\s*/, '').trim(), keywords: [] };
      continue;
    }
    if (currentRoom && line.match(/^\s+description:\s*/)) {
      currentRoom.description = line.replace(/^\s+description:\s*/, '').trim();
      continue;
    }
    if (currentRoom && line.match(/^\s+-\s+/) && !line.match(/^\s+-\s+name:/)) {
      const kw = line.replace(/^\s+-\s+/, '').trim();
      if (kw) currentRoom.keywords?.push(kw);
    }
  }
  if (currentRoom?.name) rooms.push(currentRoom as RoomConfig);

  if (!wing) wing = path.basename(path.resolve(projectDir));
  if (rooms.length === 0) rooms.push({ name: 'general', description: 'All project files', keywords: [] });

  return { wing, rooms };
}

/**
 * Mine a project directory into the palace.
 * Main entry point — equivalent to Python's mine().
 */
export async function mine(options: {
  projectDir: string;
  palacePath: string;
  wingOverride?: string;
  agent?: string;
  limit?: number;
  dryRun?: boolean;
  respectGitignore?: boolean;
  includeIgnored?: string[];
}): Promise<{ totalDrawers: number; filesProcessed: number; roomCounts: Record<string, number> }> {
  const {
    projectDir, palacePath, wingOverride, agent = 'mempalace',
    limit = 0, dryRun = false, respectGitignore = true, includeIgnored,
  } = options;

  const projectPath = path.resolve(projectDir);
  const config = loadConfig(projectDir);
  const wing = wingOverride || config.wing;
  const rooms = config.rooms;

  let files = scanProject(projectDir, respectGitignore, includeIgnored);
  if (limit > 0) files = files.slice(0, limit);

  const store = dryRun ? null : createStore(palacePath);

  let totalDrawers = 0;
  const roomCounts: Record<string, number> = {};
  let filesProcessed = 0;

  for (const filepath of files) {
    const [drawers, room] = await processFile(
      filepath, projectPath, store!, wing, rooms, agent, dryRun,
    );
    if (drawers > 0) {
      totalDrawers += drawers;
      filesProcessed++;
      if (room) roomCounts[room] = (roomCounts[room] || 0) + 1;
    }
  }

  store?.close();

  return { totalDrawers, filesProcessed, roomCounts };
}

/**
 * Show what's been filed in the palace.
 * Equivalent to Python's status().
 */
export function status(palacePath: string): { totalDrawers: number; wingRooms: Record<string, Record<string, number>> } {
  let store: VectorStore;
  try {
    store = createStore(palacePath);
  } catch {
    return { totalDrawers: 0, wingRooms: {} };
  }

  const all = store.get({ limit: 10000 });
  store.close();

  const wingRooms: Record<string, Record<string, number>> = {};
  for (const meta of all.metadatas) {
    const wing = (meta.wing as string) || '?';
    const room = (meta.room as string) || '?';
    if (!wingRooms[wing]) wingRooms[wing] = {};
    wingRooms[wing][room] = (wingRooms[wing][room] || 0) + 1;
  }

  return { totalDrawers: all.ids.length, wingRooms };
}

/**
 * Add a single drawer directly (used by MCP server / programmatic API).
 * Equivalent to Python's add_drawer.
 */
export async function addDrawer(
  store: VectorStore,
  wing: string,
  room: string,
  content: string,
  sourceFile: string,
  chunkIndex: number,
  agent: string,
): Promise<string> {
  const hash = crypto.createHash('md5').update(sourceFile + String(chunkIndex)).digest('hex').slice(0, 16);
  const drawerId = `drawer_${wing}_${room}_${hash}`;

  const metadata: DrawerMetadata = {
    wing, room, source_file: sourceFile,
    chunk_index: chunkIndex, added_by: agent,
    filed_at: new Date().toISOString(),
  };

  await store.upsert(drawerId, content, metadata);
  return drawerId;
}
