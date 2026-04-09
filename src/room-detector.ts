/**
 * room-detector.ts — Local room detection from folder structure.
 *
 * Direct port of mempalace/room_detector_local.py.
 *
 * Two ways to define rooms without calling any AI:
 *   1. Auto-detect from folder structure (zero config)
 *   2. Define manually in mempalace.yaml
 *
 * No internet. No API key. Your files stay on your machine.
 */

import * as fs from 'fs';
import * as path from 'path';

// Common room patterns — detected from folder names and filenames
export const FOLDER_ROOM_MAP: Record<string, string> = {
  frontend: 'frontend', 'front-end': 'frontend', front_end: 'frontend',
  client: 'frontend', ui: 'frontend', views: 'frontend',
  components: 'frontend', pages: 'frontend',

  backend: 'backend', 'back-end': 'backend', back_end: 'backend',
  server: 'backend', api: 'backend', routes: 'backend',
  services: 'backend', controllers: 'backend', models: 'backend',
  database: 'backend', db: 'backend',

  docs: 'documentation', doc: 'documentation', documentation: 'documentation',
  wiki: 'documentation', readme: 'documentation', notes: 'documentation',

  design: 'design', designs: 'design', mockups: 'design',
  wireframes: 'design', assets: 'design', storyboard: 'design',

  costs: 'costs', cost: 'costs', budget: 'costs',
  finance: 'costs', financial: 'costs', pricing: 'costs',
  invoices: 'costs', accounting: 'costs',

  meetings: 'meetings', meeting: 'meetings', calls: 'meetings',
  meeting_notes: 'meetings', standup: 'meetings', minutes: 'meetings',

  team: 'team', staff: 'team', hr: 'team',
  hiring: 'team', employees: 'team', people: 'team',

  research: 'research', references: 'research', reading: 'research', papers: 'research',

  planning: 'planning', roadmap: 'planning', strategy: 'planning',
  specs: 'planning', requirements: 'planning',

  tests: 'testing', test: 'testing', testing: 'testing', qa: 'testing',

  scripts: 'scripts', tools: 'scripts', utils: 'scripts',

  config: 'configuration', configs: 'configuration', settings: 'configuration',
  infrastructure: 'configuration', infra: 'configuration', deploy: 'configuration',
};

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', 'coverage',
]);

export interface DetectedRoom {
  name: string;
  description: string;
  keywords: string[];
}

/**
 * Walk the project folder structure.
 * Find top-level subdirectories that match known room patterns.
 */
export function detectRoomsFromFolders(projectDir: string): DetectedRoom[] {
  const projectPath = path.resolve(projectDir);
  const foundRooms = new Map<string, string>();

  function listDirs(dir: string): fs.Dirent[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  // Top-level directories first
  for (const item of listDirs(projectPath)) {
    if (!item.isDirectory() || SKIP_DIRS.has(item.name)) continue;
    const nameLower = item.name.toLowerCase().replace(/-/g, '_');
    if (nameLower in FOLDER_ROOM_MAP) {
      const roomName = FOLDER_ROOM_MAP[nameLower];
      if (!foundRooms.has(roomName)) foundRooms.set(roomName, item.name);
    } else if (item.name.length > 2 && /^[a-zA-Z]/.test(item.name)) {
      const clean = item.name.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
      if (!foundRooms.has(clean)) foundRooms.set(clean, item.name);
    }
  }

  // One level deeper for nested patterns
  for (const item of listDirs(projectPath)) {
    if (!item.isDirectory() || SKIP_DIRS.has(item.name)) continue;
    const subPath = path.join(projectPath, item.name);
    for (const subitem of listDirs(subPath)) {
      if (!subitem.isDirectory() || SKIP_DIRS.has(subitem.name)) continue;
      const nameLower = subitem.name.toLowerCase().replace(/-/g, '_');
      if (nameLower in FOLDER_ROOM_MAP) {
        const roomName = FOLDER_ROOM_MAP[nameLower];
        if (!foundRooms.has(roomName)) foundRooms.set(roomName, subitem.name);
      }
    }
  }

  const rooms: DetectedRoom[] = [];
  for (const [roomName, original] of foundRooms) {
    rooms.push({
      name: roomName,
      description: `Files from ${original}/`,
      keywords: [roomName, original.toLowerCase()],
    });
  }

  // Always add "general" as fallback
  if (!rooms.some(r => r.name === 'general')) {
    rooms.push({
      name: 'general',
      description: "Files that don't fit other rooms",
      keywords: [],
    });
  }

  return rooms;
}

/**
 * Fallback: detect rooms from recurring filename patterns.
 */
export function detectRoomsFromFiles(projectDir: string): DetectedRoom[] {
  const projectPath = path.resolve(projectDir);
  const keywordCounts: Record<string, number> = {};

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else {
        const nameLower = entry.name.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
        for (const [keyword, room] of Object.entries(FOLDER_ROOM_MAP)) {
          if (nameLower.includes(keyword)) {
            keywordCounts[room] = (keywordCounts[room] || 0) + 1;
          }
        }
      }
    }
  }

  walk(projectPath);

  const rooms: DetectedRoom[] = [];
  const sorted = Object.entries(keywordCounts).sort((a, b) => b[1] - a[1]);
  for (const [room, count] of sorted) {
    if (count >= 2) {
      rooms.push({
        name: room,
        description: `Files related to ${room}`,
        keywords: [room],
      });
    }
    if (rooms.length >= 6) break;
  }

  if (rooms.length === 0) {
    rooms.push({ name: 'general', description: 'All project files', keywords: [] });
  }

  return rooms;
}

/**
 * Save detected rooms to mempalace.yaml.
 */
export function saveRoomConfig(projectDir: string, projectName: string, rooms: DetectedRoom[]): string {
  const lines: string[] = [`wing: ${projectName}`, 'rooms:'];
  for (const r of rooms) {
    lines.push(`  - name: ${r.name}`);
    lines.push(`    description: ${r.description}`);
    if (r.keywords.length > 0) {
      lines.push('    keywords:');
      for (const kw of r.keywords) {
        lines.push(`      - ${kw}`);
      }
    }
  }
  const configPath = path.join(path.resolve(projectDir), 'mempalace.yaml');
  fs.writeFileSync(configPath, lines.join('\n') + '\n');
  return configPath;
}

/**
 * Main entry point for local setup.
 * Detects rooms from folder structure (or filenames as fallback) and saves to mempalace.yaml.
 */
export function detectRoomsLocal(projectDir: string): { projectName: string; rooms: DetectedRoom[]; source: string; configPath: string } {
  const projectPath = path.resolve(projectDir);
  const projectName = path.basename(projectPath).toLowerCase().replace(/ /g, '_').replace(/-/g, '_');

  if (!fs.existsSync(projectPath)) {
    throw new Error(`Directory not found: ${projectDir}`);
  }

  let rooms = detectRoomsFromFolders(projectDir);
  let source = 'folder structure';

  if (rooms.length <= 1) {
    rooms = detectRoomsFromFiles(projectDir);
    source = 'filename patterns';
  }

  if (rooms.length === 0) {
    rooms = [{ name: 'general', description: 'All project files', keywords: [] }];
    source = 'fallback (flat project)';
  }

  const configPath = saveRoomConfig(projectDir, projectName, rooms);
  return { projectName, rooms, source, configPath };
}
