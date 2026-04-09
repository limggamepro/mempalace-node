/**
 * split-mega-files.ts — Split concatenated transcript files into per-session files.
 *
 * Direct port of mempalace/split_mega_files.py.
 *
 * Scans a directory for .txt files containing multiple Claude Code sessions
 * (identified by "Claude Code v" headers). Splits each into individual files
 * named with: date, time, people detected, and subject from first prompt.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOME = os.homedir();
const DEFAULT_SOURCE_DIR = process.env.MEMPALACE_SOURCE_DIR || path.join(HOME, 'Desktop', 'transcripts');
const KNOWN_NAMES_PATH = path.join(HOME, '.mempalace', 'known_names.json');
const FALLBACK_KNOWN_PEOPLE = ['Alice', 'Ben', 'Riley', 'Max', 'Sam', 'Devon', 'Jordan'];

let knownNamesCache: any = null;

function loadKnownNamesConfig(forceReload = false): any {
  if (forceReload) knownNamesCache = null;
  if (knownNamesCache !== null) return knownNamesCache;

  if (fs.existsSync(KNOWN_NAMES_PATH)) {
    try {
      knownNamesCache = JSON.parse(fs.readFileSync(KNOWN_NAMES_PATH, 'utf-8'));
      return knownNamesCache;
    } catch { /* fall through */ }
  }
  knownNamesCache = null;
  return null;
}

export function loadKnownPeople(): string[] {
  const data = loadKnownNamesConfig();
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return data.names || [];
  return [...FALLBACK_KNOWN_PEOPLE];
}

function loadUsernameMap(): Record<string, string> {
  const data = loadKnownNamesConfig();
  if (data && typeof data === 'object') return data.username_map || {};
  return {};
}

/**
 * True session start: 'Claude Code v' header NOT followed by 'Ctrl+E'/'previous messages'.
 */
export function isTrueSessionStart(lines: string[], idx: number): boolean {
  const nearby = lines.slice(idx, idx + 6).join('');
  return !nearby.includes('Ctrl+E') && !nearby.includes('previous messages');
}

/** Return list of line indices where true new sessions begin. */
export function findSessionBoundaries(lines: string[]): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Claude Code v') && isTrueSessionStart(lines, i)) {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/**
 * Find the first timestamp line: ⏺ H:MM AM/PM Weekday, Month DD, YYYY
 */
export function extractTimestamp(lines: string[]): { human: string | null; iso: string | null } {
  const tsPattern = /⏺\s+(\d{1,2}:\d{2}\s+[AP]M)\s+\w+,\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/;
  const months: Record<string, string> = {
    January: '01', February: '02', March: '03', April: '04',
    May: '05', June: '06', July: '07', August: '08',
    September: '09', October: '10', November: '11', December: '12',
  };
  for (const line of lines.slice(0, 50)) {
    const m = line.match(tsPattern);
    if (m) {
      const [, timeStr, month, day, year] = m;
      const mon = months[month] || '00';
      const dayZ = day.padStart(2, '0');
      const timeSafe = timeStr.replace(':', '').replace(' ', '');
      return { iso: `${year}-${mon}-${dayZ}`, human: `${year}-${mon}-${dayZ}_${timeSafe}` };
    }
  }
  return { human: null, iso: null };
}

/** Detect people mentioned in the first 100 lines. */
export function extractPeople(lines: string[]): string[] {
  const found = new Set<string>();
  const text = lines.slice(0, 100).join('');
  const knownPeople = loadKnownPeople();

  for (const person of knownPeople) {
    const escaped = person.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
      found.add(person);
    }
  }

  const dirMatch = text.match(/\/Users\/(\w+)\//);
  if (dirMatch) {
    const username = dirMatch[1];
    const usernameMap = loadUsernameMap();
    if (username in usernameMap) found.add(usernameMap[username]);
  }

  return [...found].sort();
}

/** Find the first meaningful user prompt (> line that isn't a shell command). */
export function extractSubject(lines: string[]): string {
  const skipPattern = /^(\.\/|cd |ls |python|bash|git |cat |source |export |claude|\.\/activate)/;
  for (const line of lines) {
    if (line.startsWith('> ')) {
      const prompt = line.slice(2).trim();
      if (prompt && !skipPattern.test(prompt) && prompt.length > 5) {
        let subject = prompt.replace(/[^\w\s-]/g, '');
        subject = subject.trim().replace(/\s+/g, '-');
        return subject.slice(0, 60);
      }
    }
  }
  return 'session';
}

export interface SplitOptions {
  outputDir?: string;
  dryRun?: boolean;
}

/**
 * Split a single mega-file into per-session files.
 */
export function splitFile(filepath: string, options: SplitOptions = {}): string[] {
  const { outputDir, dryRun = false } = options;
  const content = fs.readFileSync(filepath, 'utf-8');
  const lines = content.split(/(?<=\n)/);

  const boundaries = findSessionBoundaries(lines);
  if (boundaries.length < 2) return [];

  boundaries.push(lines.length);
  const outDir = outputDir || path.dirname(filepath);
  const written: string[] = [];
  const stem = path.basename(filepath, path.extname(filepath));

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const chunk = lines.slice(start, end);
    if (chunk.length < 10) continue;

    const { human } = extractTimestamp(chunk);
    const people = extractPeople(chunk);
    const subject = extractSubject(chunk);

    const tsPart = human || `part${String(i + 1).padStart(2, '0')}`;
    const peoplePart = people.length > 0 ? people.slice(0, 3).join('-') : 'unknown';
    const srcStem = stem.replace(/[^\w-]/g, '_').slice(0, 40);
    let name = `${srcStem}__${tsPart}_${peoplePart}_${subject}.txt`;
    name = name.replace(/[^\w.\-]/g, '_').replace(/_+/g, '_');

    const outPath = path.join(outDir, name);

    if (!dryRun) {
      fs.writeFileSync(outPath, chunk.join(''));
    }
    written.push(outPath);
  }

  return written;
}

/**
 * Scan a directory and split all mega-files found.
 */
export function splitMegaFiles(options: {
  sourceDir?: string;
  outputDir?: string;
  minSessions?: number;
  dryRun?: boolean;
} = {}): { files: string[]; totalWritten: number } {
  const sourceDir = options.sourceDir || DEFAULT_SOURCE_DIR;
  const minSessions = options.minSessions ?? 2;
  const dryRun = options.dryRun ?? false;

  const allFiles = fs.readdirSync(sourceDir).filter(f => f.endsWith('.txt')).sort();
  const megaFiles: Array<{ path: string; sessions: number }> = [];

  for (const f of allFiles) {
    const fpath = path.join(sourceDir, f);
    const content = fs.readFileSync(fpath, 'utf-8');
    const lines = content.split(/(?<=\n)/);
    const boundaries = findSessionBoundaries(lines);
    if (boundaries.length >= minSessions) {
      megaFiles.push({ path: fpath, sessions: boundaries.length });
    }
  }

  let totalWritten = 0;
  const allWritten: string[] = [];

  for (const { path: fpath } of megaFiles) {
    const written = splitFile(fpath, { outputDir: options.outputDir, dryRun });
    totalWritten += written.length;
    allWritten.push(...written);

    if (!dryRun && written.length > 0) {
      const backup = fpath.replace(/\.txt$/, '.mega_backup');
      fs.renameSync(fpath, backup);
    }
  }

  return { files: allWritten, totalWritten };
}
