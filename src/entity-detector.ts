/**
 * entity-detector.ts — Auto-detect people and projects from file content.
 *
 * Direct port of mempalace/entity_detector.py.
 *
 * Two-pass approach:
 *   Pass 1: scan files, extract entity candidates with signal counts
 *   Pass 2: score and classify each candidate as person, project, or uncertain
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Signal patterns ─────────────────────────────────────────────────────────

const PERSON_VERB_PATTERNS = [
  '\\b{name}\\s+said\\b', '\\b{name}\\s+asked\\b', '\\b{name}\\s+told\\b',
  '\\b{name}\\s+replied\\b', '\\b{name}\\s+laughed\\b', '\\b{name}\\s+smiled\\b',
  '\\b{name}\\s+cried\\b', '\\b{name}\\s+felt\\b', '\\b{name}\\s+thinks?\\b',
  '\\b{name}\\s+wants?\\b', '\\b{name}\\s+loves?\\b', '\\b{name}\\s+hates?\\b',
  '\\b{name}\\s+knows?\\b', '\\b{name}\\s+decided\\b', '\\b{name}\\s+pushed\\b',
  '\\b{name}\\s+wrote\\b', '\\bhey\\s+{name}\\b', '\\bthanks?\\s+{name}\\b',
  '\\bhi\\s+{name}\\b', '\\bdear\\s+{name}\\b',
];

const PRONOUN_PATTERNS = [
  '\\bshe\\b', '\\bher\\b', '\\bhers\\b', '\\bhe\\b', '\\bhim\\b',
  '\\bhis\\b', '\\bthey\\b', '\\bthem\\b', '\\btheir\\b',
];

const DIALOGUE_PATTERNS = [
  '^>\\s*{name}[:\\s]', '^{name}:\\s', '^\\[{name}\\]', '"{name}\\s+said',
];

const PROJECT_VERB_PATTERNS = [
  '\\bbuilding\\s+{name}\\b', '\\bbuilt\\s+{name}\\b',
  '\\bship(?:ping|ped)?\\s+{name}\\b', '\\blaunch(?:ing|ed)?\\s+{name}\\b',
  '\\bdeploy(?:ing|ed)?\\s+{name}\\b', '\\binstall(?:ing|ed)?\\s+{name}\\b',
  '\\bthe\\s+{name}\\s+architecture\\b', '\\bthe\\s+{name}\\s+pipeline\\b',
  '\\bthe\\s+{name}\\s+system\\b', '\\bthe\\s+{name}\\s+repo\\b',
  '\\b{name}\\s+v\\d+\\b', '\\b{name}\\.py\\b',
  '\\b{name}-core\\b', '\\b{name}-local\\b',
  '\\bimport\\s+{name}\\b', '\\bpip\\s+install\\s+{name}\\b',
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you',
  'your', 'i', 'my', 'me', 'he', 'she', 'his', 'her', 'who', 'what', 'when',
  'where', 'why', 'how', 'which', 'if', 'then', 'so', 'not', 'no', 'yes',
  'ok', 'okay', 'just', 'very', 'really', 'also', 'already', 'still', 'even',
  'only', 'here', 'there', 'now', 'too', 'up', 'out', 'about', 'like', 'use',
  'get', 'got', 'make', 'made', 'take', 'put', 'come', 'go', 'see', 'know',
  'think', 'true', 'false', 'none', 'null', 'new', 'old', 'all', 'any', 'some',
  'return', 'print', 'def', 'class', 'import',
  // Common capitalized words in prose
  'step', 'usage', 'run', 'check', 'find', 'add', 'set', 'list', 'args',
  'dict', 'str', 'int', 'bool', 'path', 'file', 'type', 'name', 'note',
  'example', 'option', 'result', 'error', 'warning', 'info', 'every', 'each',
  'more', 'less', 'next', 'last', 'first', 'second', 'stack', 'layer', 'mode',
  'test', 'stop', 'start', 'copy', 'move', 'source', 'target', 'output',
  'input', 'data', 'item', 'key', 'value', 'returns', 'raises', 'yields',
  'self', 'cls', 'kwargs',
  // Sentence-starting / abstract words
  'world', 'well', 'want', 'topic', 'choose', 'social', 'cars', 'phones',
  'healthcare', 'ex', 'machina', 'deus', 'human', 'humans', 'people', 'things',
  'something', 'nothing', 'everything', 'anything', 'someone', 'everyone',
  'anyone', 'way', 'time', 'day', 'life', 'place', 'thing', 'part', 'kind',
  'sort', 'case', 'point', 'idea', 'fact', 'sense', 'question', 'answer',
  'reason', 'number', 'version', 'system',
  // Greetings
  'hey', 'hi', 'hello', 'thanks', 'thank', 'right', 'let',
  // UI/action words
  'click', 'hit', 'press', 'tap', 'drag', 'drop', 'open', 'close', 'save',
  'load', 'launch', 'install', 'download', 'upload', 'scroll', 'select',
  'enter', 'submit', 'cancel', 'confirm', 'delete', 'paste', 'write', 'read',
  'search', 'show', 'hide',
  // Filesystem/technical
  'desktop', 'documents', 'downloads', 'users', 'home', 'library',
  'applications', 'preferences', 'settings', 'terminal',
  // Abstract topic words
  'actor', 'vector', 'remote', 'control', 'duration', 'fetch',
  'agents', 'tools', 'others', 'guards', 'ethics', 'regulation', 'learning',
  'thinking', 'memory', 'language', 'intelligence', 'technology', 'society',
  'culture', 'future', 'history', 'science', 'model', 'models', 'network',
  'networks', 'training', 'inference',
]);

const PROSE_EXTENSIONS = new Set(['.txt', '.md', '.rst', '.csv']);

const READABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.js', '.ts', '.json', '.yaml', '.yml',
  '.csv', '.rst', '.toml', '.sh', '.rb', '.go', '.rs',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', 'coverage', '.mempalace',
]);

// ── Candidate extraction ────────────────────────────────────────────────────

/**
 * Extract all capitalized proper noun candidates from text.
 * Returns {name: frequency} for names appearing 3+ times.
 */
export function extractCandidates(text: string): Record<string, number> {
  const counts: Record<string, number> = {};

  // Single capitalized words
  const single = text.match(/\b[A-Z][a-z]{1,19}\b/g) || [];
  for (const word of single) {
    if (!STOPWORDS.has(word.toLowerCase()) && word.length > 1) {
      counts[word] = (counts[word] || 0) + 1;
    }
  }

  // Multi-word proper nouns
  const multi = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  for (const phrase of multi) {
    const words = phrase.split(/\s+/);
    if (!words.some(w => STOPWORDS.has(w.toLowerCase()))) {
      counts[phrase] = (counts[phrase] || 0) + 1;
    }
  }

  // Filter: must appear 3+ times
  return Object.fromEntries(
    Object.entries(counts).filter(([, count]) => count >= 3),
  );
}

// ── Signal scoring ──────────────────────────────────────────────────────────

interface CompiledPatterns {
  dialogue: RegExp[];
  personVerbs: RegExp[];
  projectVerbs: RegExp[];
  direct: RegExp;
  versioned: RegExp;
  codeRef: RegExp;
}

function buildPatterns(name: string): CompiledPatterns {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    dialogue: DIALOGUE_PATTERNS.map(p => new RegExp(p.replace(/{name}/g, escaped), 'mi')),
    personVerbs: PERSON_VERB_PATTERNS.map(p => new RegExp(p.replace(/{name}/g, escaped), 'gi')),
    projectVerbs: PROJECT_VERB_PATTERNS.map(p => new RegExp(p.replace(/{name}/g, escaped), 'gi')),
    direct: new RegExp(`\\bhey\\s+${escaped}\\b|\\bthanks?\\s+${escaped}\\b|\\bhi\\s+${escaped}\\b`, 'gi'),
    versioned: new RegExp(`\\b${escaped}[-v]\\w+`, 'gi'),
    codeRef: new RegExp(`\\b${escaped}\\.(py|js|ts|yaml|yml|json|sh)\\b`, 'gi'),
  };
}

export interface EntityScores {
  person_score: number;
  project_score: number;
  person_signals: string[];
  project_signals: string[];
}

/**
 * Score a candidate entity as person vs project.
 */
export function scoreEntity(name: string, text: string, lines: string[]): EntityScores {
  const patterns = buildPatterns(name);
  let personScore = 0;
  let projectScore = 0;
  const personSignals: string[] = [];
  const projectSignals: string[] = [];

  // Person signals — dialogue
  for (const rx of patterns.dialogue) {
    const matches = (text.match(new RegExp(rx.source, rx.flags + 'g')) || []).length;
    if (matches > 0) {
      personScore += matches * 3;
      personSignals.push(`dialogue marker (${matches}x)`);
    }
  }

  // Person verbs
  for (const rx of patterns.personVerbs) {
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      personScore += matches * 2;
      personSignals.push(`'${name} ...' action (${matches}x)`);
    }
  }

  // Pronoun proximity
  const nameLower = name.toLowerCase();
  const nameLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(nameLower)) nameLineIndices.push(i);
  }
  let pronounHits = 0;
  for (const idx of nameLineIndices) {
    const windowText = lines.slice(Math.max(0, idx - 2), idx + 3).join(' ').toLowerCase();
    for (const pp of PRONOUN_PATTERNS) {
      if (new RegExp(pp).test(windowText)) {
        pronounHits++;
        break;
      }
    }
  }
  if (pronounHits > 0) {
    personScore += pronounHits * 2;
    personSignals.push(`pronoun nearby (${pronounHits}x)`);
  }

  // Direct address
  const direct = (text.match(patterns.direct) || []).length;
  if (direct > 0) {
    personScore += direct * 4;
    personSignals.push(`addressed directly (${direct}x)`);
  }

  // Project signals
  for (const rx of patterns.projectVerbs) {
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      projectScore += matches * 2;
      projectSignals.push(`project verb (${matches}x)`);
    }
  }

  const versioned = (text.match(patterns.versioned) || []).length;
  if (versioned > 0) {
    projectScore += versioned * 3;
    projectSignals.push(`versioned/hyphenated (${versioned}x)`);
  }

  const codeRef = (text.match(patterns.codeRef) || []).length;
  if (codeRef > 0) {
    projectScore += codeRef * 3;
    projectSignals.push(`code file reference (${codeRef}x)`);
  }

  return {
    person_score: personScore,
    project_score: projectScore,
    person_signals: personSignals.slice(0, 3),
    project_signals: projectSignals.slice(0, 3),
  };
}

// ── Classify ────────────────────────────────────────────────────────────────

export interface ClassifiedEntity {
  name: string;
  type: 'person' | 'project' | 'uncertain';
  confidence: number;
  frequency: number;
  signals: string[];
}

/**
 * Given scores, classify as person / project / uncertain.
 */
export function classifyEntity(name: string, frequency: number, scores: EntityScores): ClassifiedEntity {
  const ps = scores.person_score;
  const prs = scores.project_score;
  const total = ps + prs;

  if (total === 0) {
    const confidence = Math.min(0.4, frequency / 50);
    return {
      name, type: 'uncertain',
      confidence: Math.round(confidence * 100) / 100,
      frequency,
      signals: [`appears ${frequency}x, no strong type signals`],
    };
  }

  const personRatio = ps / total;

  // Require TWO different signal categories
  const signalCategories = new Set<string>();
  for (const s of scores.person_signals) {
    if (s.includes('dialogue')) signalCategories.add('dialogue');
    else if (s.includes('action')) signalCategories.add('action');
    else if (s.includes('pronoun')) signalCategories.add('pronoun');
    else if (s.includes('addressed')) signalCategories.add('addressed');
  }
  const hasTwoSignalTypes = signalCategories.size >= 2;

  let entityType: 'person' | 'project' | 'uncertain';
  let confidence: number;
  let signals: string[];

  if (personRatio >= 0.7 && hasTwoSignalTypes && ps >= 5) {
    entityType = 'person';
    confidence = Math.min(0.99, 0.5 + personRatio * 0.5);
    signals = scores.person_signals.length > 0 ? scores.person_signals : [`appears ${frequency}x`];
  } else if (personRatio >= 0.7 && (!hasTwoSignalTypes || ps < 5)) {
    entityType = 'uncertain';
    confidence = 0.4;
    signals = [...scores.person_signals, `appears ${frequency}x — pronoun-only match`];
  } else if (personRatio <= 0.3) {
    entityType = 'project';
    confidence = Math.min(0.99, 0.5 + (1 - personRatio) * 0.5);
    signals = scores.project_signals.length > 0 ? scores.project_signals : [`appears ${frequency}x`];
  } else {
    entityType = 'uncertain';
    confidence = 0.5;
    signals = [...scores.person_signals, ...scores.project_signals].slice(0, 3);
    signals.push('mixed signals — needs review');
  }

  return {
    name, type: entityType,
    confidence: Math.round(confidence * 100) / 100,
    frequency, signals,
  };
}

// ── Main detect ─────────────────────────────────────────────────────────────

export interface DetectionResult {
  people: ClassifiedEntity[];
  projects: ClassifiedEntity[];
  uncertain: ClassifiedEntity[];
}

/**
 * Scan files and detect entity candidates.
 */
export function detectEntities(filePaths: string[], maxFiles = 10): DetectionResult {
  const allText: string[] = [];
  const allLines: string[] = [];
  let filesRead = 0;
  const MAX_BYTES_PER_FILE = 5000;

  for (const filepath of filePaths) {
    if (filesRead >= maxFiles) break;
    try {
      const fd = fs.openSync(filepath, 'r');
      const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
      const bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES_PER_FILE, 0);
      fs.closeSync(fd);
      const content = buf.slice(0, bytesRead).toString('utf-8');
      allText.push(content);
      allLines.push(...content.split('\n'));
      filesRead++;
    } catch {
      continue;
    }
  }

  const combinedText = allText.join('\n');
  const candidates = extractCandidates(combinedText);

  if (Object.keys(candidates).length === 0) {
    return { people: [], projects: [], uncertain: [] };
  }

  const people: ClassifiedEntity[] = [];
  const projects: ClassifiedEntity[] = [];
  const uncertain: ClassifiedEntity[] = [];

  const sorted = Object.entries(candidates).sort((a, b) => b[1] - a[1]);
  for (const [name, frequency] of sorted) {
    const scores = scoreEntity(name, combinedText, allLines);
    const entity = classifyEntity(name, frequency, scores);
    if (entity.type === 'person') people.push(entity);
    else if (entity.type === 'project') projects.push(entity);
    else uncertain.push(entity);
  }

  people.sort((a, b) => b.confidence - a.confidence);
  projects.sort((a, b) => b.confidence - a.confidence);
  uncertain.sort((a, b) => b.frequency - a.frequency);

  return {
    people: people.slice(0, 15),
    projects: projects.slice(0, 10),
    uncertain: uncertain.slice(0, 8),
  };
}

// ── Scan helper ─────────────────────────────────────────────────────────────

/**
 * Collect prose file paths for entity detection.
 * Prose only (.txt, .md, .rst, .csv) — code files produce false positives.
 */
export function scanForDetection(projectDir: string, maxFiles = 10): string[] {
  const projectPath = path.resolve(projectDir);
  const proseFiles: string[] = [];
  const allFiles: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (PROSE_EXTENSIONS.has(ext)) proseFiles.push(fullPath);
        else if (READABLE_EXTENSIONS.has(ext)) allFiles.push(fullPath);
      }
    }
  }

  walk(projectPath);

  const files = proseFiles.length >= 3 ? proseFiles : [...proseFiles, ...allFiles];
  return files.slice(0, maxFiles);
}
