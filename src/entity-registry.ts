/**
 * entity-registry.ts — Persistent personal entity registry for MemPalace.
 *
 * Direct port of mempalace/entity_registry.py.
 *
 * Knows the difference between Riley (a person) and ever (an adverb).
 * Built from three sources, in priority order:
 *   1. Onboarding — what the user explicitly told us
 *   2. Learned — what we inferred from session history with high confidence
 *   3. Researched — what we looked up via Wikipedia for unknown words
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Common English words that could be confused with names ──────────────────

export const COMMON_ENGLISH_WORDS = new Set([
  // Words that are also common personal names
  'ever', 'grace', 'will', 'bill', 'mark', 'april', 'may', 'june', 'joy',
  'hope', 'faith', 'chance', 'chase', 'hunter', 'dash', 'flash', 'star',
  'sky', 'river', 'brook', 'lane', 'art', 'clay', 'gil', 'nat', 'max',
  'rex', 'ray', 'jay', 'rose', 'violet', 'lily', 'ivy', 'ash', 'reed', 'sage',
  // Words that look like names at start of sentence
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'july', 'august', 'september', 'october',
  'november', 'december',
]);

// Context patterns that indicate a word is being used as a PERSON name
const PERSON_CONTEXT_PATTERNS = [
  '\\b{name}\\s+said\\b', '\\b{name}\\s+told\\b', '\\b{name}\\s+asked\\b',
  '\\b{name}\\s+laughed\\b', '\\b{name}\\s+smiled\\b', '\\b{name}\\s+was\\b',
  '\\b{name}\\s+is\\b', '\\b{name}\\s+called\\b', '\\b{name}\\s+texted\\b',
  '\\bwith\\s+{name}\\b', '\\bsaw\\s+{name}\\b', '\\bcalled\\s+{name}\\b',
  '\\btook\\s+{name}\\b', '\\bpicked\\s+up\\s+{name}\\b',
  '\\bdrop(?:ped)?\\s+(?:off\\s+)?{name}\\b',
  "\\b{name}(?:'s|s')\\b",
  '\\bhey\\s+{name}\\b', '\\bthanks?\\s+{name}\\b',
  '^{name}[:\\s]',
  '\\bmy\\s+(?:son|daughter|kid|child|brother|sister|friend|partner|colleague|coworker)\\s+{name}\\b',
];

// Context patterns that indicate a word is NOT being used as a name
const CONCEPT_CONTEXT_PATTERNS = [
  '\\bhave\\s+you\\s+{name}\\b', '\\bif\\s+you\\s+{name}\\b',
  '\\b{name}\\s+since\\b', '\\b{name}\\s+again\\b', '\\bnot\\s+{name}\\b',
  '\\b{name}\\s+more\\b', '\\bwould\\s+{name}\\b', '\\bcould\\s+{name}\\b',
  '\\bwill\\s+{name}\\b',
  '(?:the\\s+)?{name}\\s+(?:of|in|at|for|to)\\b',
];

// ── Wikipedia name/place indicators ─────────────────────────────────────────

const NAME_INDICATOR_PHRASES = [
  'given name', 'personal name', 'first name', 'forename', 'masculine name',
  'feminine name', "boy's name", "girl's name", 'male name', 'female name',
  'irish name', 'welsh name', 'scottish name', 'gaelic name', 'hebrew name',
  'arabic name', 'norse name', 'old english name', 'is a name', 'as a name',
  'name meaning', 'name derived from', 'legendary irish', 'legendary welsh',
  'legendary scottish',
];

const PLACE_INDICATOR_PHRASES = [
  'city in', 'town in', 'village in', 'municipality', 'capital of',
  'district of', 'county', 'province', 'region of', 'island of',
  'mountain in', 'river in',
];

// ── Wikipedia lookup ────────────────────────────────────────────────────────

export interface WikiLookupResult {
  inferred_type: 'person' | 'place' | 'concept' | 'ambiguous' | 'unknown';
  confidence: number;
  wiki_summary: string | null;
  wiki_title?: string;
  note?: string;
  word?: string;
  confirmed?: boolean;
  confirmed_type?: string;
}

async function wikipediaLookup(word: string): Promise<WikiLookupResult> {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MemPalace/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (resp.status === 404) {
      return {
        inferred_type: 'person', confidence: 0.70,
        wiki_summary: null, wiki_title: undefined,
        note: 'not found in Wikipedia — likely a proper noun or unusual name',
      };
    }
    if (!resp.ok) return { inferred_type: 'unknown', confidence: 0.0, wiki_summary: null };

    const data = await resp.json() as Record<string, unknown>;
    const pageType = (data.type as string) || '';
    const extract = ((data.extract as string) || '').toLowerCase();
    const title = (data.title as string) || word;

    if (pageType === 'disambiguation') {
      const desc = ((data.description as string) || '').toLowerCase();
      if (desc.includes('name') || desc.includes('given name')) {
        return {
          inferred_type: 'person', confidence: 0.65,
          wiki_summary: extract.slice(0, 200), wiki_title: title,
          note: 'disambiguation page with name entries',
        };
      }
      return {
        inferred_type: 'ambiguous', confidence: 0.4,
        wiki_summary: extract.slice(0, 200), wiki_title: title,
      };
    }

    if (NAME_INDICATOR_PHRASES.some(p => extract.includes(p))) {
      const wordLower = word.toLowerCase();
      const isStrong = extract.includes(`${wordLower} is a`) || extract.includes(`${wordLower} (name`);
      return {
        inferred_type: 'person', confidence: isStrong ? 0.90 : 0.80,
        wiki_summary: extract.slice(0, 200), wiki_title: title,
      };
    }

    if (PLACE_INDICATOR_PHRASES.some(p => extract.includes(p))) {
      return {
        inferred_type: 'place', confidence: 0.80,
        wiki_summary: extract.slice(0, 200), wiki_title: title,
      };
    }

    return {
      inferred_type: 'concept', confidence: 0.60,
      wiki_summary: extract.slice(0, 200), wiki_title: title,
    };
  } catch {
    return { inferred_type: 'unknown', confidence: 0.0, wiki_summary: null };
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface PersonEntry {
  source: 'onboarding' | 'learned' | 'wiki';
  contexts: string[];
  aliases: string[];
  relationship: string;
  confidence: number;
  canonical?: string;
  seen_count?: number;
}

export interface RegistryData {
  version: number;
  mode: 'personal' | 'work' | 'combo';
  people: Record<string, PersonEntry>;
  projects: string[];
  ambiguous_flags: string[];
  wiki_cache: Record<string, WikiLookupResult>;
}

export interface LookupResult {
  type: 'person' | 'project' | 'concept' | 'unknown' | 'place' | 'ambiguous';
  confidence: number;
  source: string;
  name: string;
  context?: string[];
  needs_disambiguation: boolean;
  disambiguated_by?: string;
}

export interface SeedPerson {
  name: string;
  relationship?: string;
  context?: string;
}

// ── EntityRegistry class ────────────────────────────────────────────────────

export class EntityRegistry {
  static DEFAULT_PATH = path.join(os.homedir(), '.mempalace', 'entity_registry.json');

  private data: RegistryData;
  private path: string;

  constructor(data: RegistryData, filePath: string) {
    this.data = data;
    this.path = filePath;
  }

  static load(configDir?: string): EntityRegistry {
    const filePath = configDir
      ? path.join(configDir, 'entity_registry.json')
      : EntityRegistry.DEFAULT_PATH;

    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RegistryData;
        return new EntityRegistry(data, filePath);
      } catch { /* fall through */ }
    }
    return new EntityRegistry(EntityRegistry.empty(), filePath);
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  static empty(): RegistryData {
    return {
      version: 1,
      mode: 'personal',
      people: {},
      projects: [],
      ambiguous_flags: [],
      wiki_cache: {},
    };
  }

  // ── Properties ────────────────────────────────────────────────────────

  get mode(): string { return this.data.mode || 'personal'; }
  get people(): Record<string, PersonEntry> { return this.data.people || {}; }
  get projects(): string[] { return this.data.projects || []; }
  get ambiguousFlags(): string[] { return this.data.ambiguous_flags || []; }
  get rawData(): RegistryData { return this.data; }

  // ── Seed from onboarding ──────────────────────────────────────────────

  seed(mode: 'personal' | 'work' | 'combo', people: SeedPerson[], projects: string[], aliases: Record<string, string> = {}): void {
    this.data.mode = mode;
    this.data.projects = [...projects];

    const reverseAliases: Record<string, string> = {};
    for (const [k, v] of Object.entries(aliases)) reverseAliases[v] = k;

    for (const entry of people) {
      const name = entry.name.trim();
      if (!name) continue;
      const context = entry.context || 'personal';
      const relationship = entry.relationship || '';

      this.data.people[name] = {
        source: 'onboarding',
        contexts: [context],
        aliases: name in reverseAliases ? [reverseAliases[name]] : [],
        relationship,
        confidence: 1.0,
      };

      if (name in reverseAliases) {
        const alias = reverseAliases[name];
        this.data.people[alias] = {
          source: 'onboarding',
          contexts: [context],
          aliases: [name],
          relationship,
          confidence: 1.0,
          canonical: name,
        };
      }
    }

    // Flag ambiguous names
    const ambiguous: string[] = [];
    for (const name of Object.keys(this.data.people)) {
      if (COMMON_ENGLISH_WORDS.has(name.toLowerCase())) {
        ambiguous.push(name.toLowerCase());
      }
    }
    this.data.ambiguous_flags = ambiguous;
    this.save();
  }

  // ── Lookup ────────────────────────────────────────────────────────────

  lookup(word: string, context = ''): LookupResult {
    const wordLower = word.toLowerCase();

    // 1. Exact match in people
    for (const [canonical, info] of Object.entries(this.people)) {
      const aliasLower = info.aliases.map(a => a.toLowerCase());
      if (wordLower === canonical.toLowerCase() || aliasLower.includes(wordLower)) {
        if (this.ambiguousFlags.includes(wordLower) && context) {
          const resolved = this.disambiguate(word, context, info);
          if (resolved !== null) return resolved;
        }
        return {
          type: 'person', confidence: info.confidence,
          source: info.source, name: canonical,
          context: info.contexts || ['personal'],
          needs_disambiguation: false,
        };
      }
    }

    // 2. Project match
    for (const proj of this.projects) {
      if (wordLower === proj.toLowerCase()) {
        return {
          type: 'project', confidence: 1.0, source: 'onboarding',
          name: proj, needs_disambiguation: false,
        };
      }
    }

    // 3. Wiki cache
    const cache = this.data.wiki_cache || {};
    for (const [cachedWord, cachedResult] of Object.entries(cache)) {
      if (wordLower === cachedWord.toLowerCase() && cachedResult.confirmed) {
        return {
          type: cachedResult.inferred_type as LookupResult['type'],
          confidence: cachedResult.confidence,
          source: 'wiki', name: word, needs_disambiguation: false,
        };
      }
    }

    return {
      type: 'unknown', confidence: 0.0, source: 'none',
      name: word, needs_disambiguation: false,
    };
  }

  private disambiguate(word: string, context: string, personInfo: PersonEntry): LookupResult | null {
    const nameLower = word.toLowerCase();
    const ctxLower = context.toLowerCase();
    const escapedName = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let personScore = 0;
    for (const pat of PERSON_CONTEXT_PATTERNS) {
      const regex = new RegExp(pat.replace(/{name}/g, escapedName));
      if (regex.test(ctxLower)) personScore++;
    }

    let conceptScore = 0;
    for (const pat of CONCEPT_CONTEXT_PATTERNS) {
      const regex = new RegExp(pat.replace(/{name}/g, escapedName));
      if (regex.test(ctxLower)) conceptScore++;
    }

    if (personScore > conceptScore) {
      return {
        type: 'person',
        confidence: Math.min(0.95, 0.7 + personScore * 0.1),
        source: personInfo.source, name: word,
        context: personInfo.contexts || ['personal'],
        needs_disambiguation: false,
        disambiguated_by: 'context_patterns',
      };
    } else if (conceptScore > personScore) {
      return {
        type: 'concept',
        confidence: Math.min(0.90, 0.7 + conceptScore * 0.1),
        source: 'context_disambiguated', name: word,
        needs_disambiguation: false,
        disambiguated_by: 'context_patterns',
      };
    }

    return null;
  }

  // ── Research unknown words ────────────────────────────────────────────

  async research(word: string, autoConfirm = false): Promise<WikiLookupResult> {
    if (!this.data.wiki_cache) this.data.wiki_cache = {};
    if (word in this.data.wiki_cache) return this.data.wiki_cache[word];

    const result = await wikipediaLookup(word);
    result.word = word;
    result.confirmed = autoConfirm;

    this.data.wiki_cache[word] = result;
    this.save();
    return result;
  }

  confirmResearch(word: string, entityType: string, relationship = '', context = 'personal'): void {
    const cache = this.data.wiki_cache || {};
    if (word in cache) {
      cache[word].confirmed = true;
      cache[word].confirmed_type = entityType;
    }

    if (entityType === 'person') {
      this.data.people[word] = {
        source: 'wiki',
        contexts: [context],
        aliases: [],
        relationship,
        confidence: 0.90,
      };
      if (COMMON_ENGLISH_WORDS.has(word.toLowerCase())) {
        if (!this.data.ambiguous_flags.includes(word.toLowerCase())) {
          this.data.ambiguous_flags.push(word.toLowerCase());
        }
      }
    }
    this.save();
  }

  // ── Learn from sessions (uses entity-detector) ────────────────────────

  async learnFromText(text: string, minConfidence = 0.75): Promise<Array<{ name: string; type: string; confidence: number }>> {
    // Lazy import to avoid circular deps
    const { extractCandidates, scoreEntity, classifyEntity } = await import('./entity-detector');

    const lines = text.split('\n');
    const candidates = extractCandidates(text);
    const newCandidates: Array<{ name: string; type: string; confidence: number }> = [];

    for (const [name, frequency] of Object.entries(candidates)) {
      if (name in this.people || this.projects.includes(name)) continue;

      const scores = scoreEntity(name, text, lines);
      const entity = classifyEntity(name, frequency, scores);

      if (entity.type === 'person' && entity.confidence >= minConfidence) {
        this.data.people[name] = {
          source: 'learned',
          contexts: [this.mode !== 'combo' ? this.mode as 'personal' | 'work' : 'personal'],
          aliases: [],
          relationship: '',
          confidence: entity.confidence,
          seen_count: frequency,
        };
        if (COMMON_ENGLISH_WORDS.has(name.toLowerCase())) {
          if (!this.data.ambiguous_flags.includes(name.toLowerCase())) {
            this.data.ambiguous_flags.push(name.toLowerCase());
          }
        }
        newCandidates.push(entity);
      }
    }

    if (newCandidates.length > 0) this.save();
    return newCandidates;
  }

  // ── Query helpers ─────────────────────────────────────────────────────

  extractPeopleFromQuery(query: string): string[] {
    const found: string[] = [];

    for (const [canonical, info] of Object.entries(this.people)) {
      const namesToCheck = [canonical, ...info.aliases];
      for (const name of namesToCheck) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (regex.test(query)) {
          if (this.ambiguousFlags.includes(name.toLowerCase())) {
            const result = this.disambiguate(name, query, info);
            if (result && result.type === 'person' && !found.includes(canonical)) {
              found.push(canonical);
            }
          } else if (!found.includes(canonical)) {
            found.push(canonical);
          }
        }
      }
    }
    return found;
  }

  extractUnknownCandidates(query: string): string[] {
    const candidates = query.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const word of candidates) {
      if (seen.has(word)) continue;
      seen.add(word);
      if (COMMON_ENGLISH_WORDS.has(word.toLowerCase())) continue;
      const result = this.lookup(word);
      if (result.type === 'unknown') unknown.push(word);
    }
    return unknown;
  }

  // ── Summary ───────────────────────────────────────────────────────────

  summary(): string {
    const peopleNames = Object.keys(this.people);
    const peopleStr = peopleNames.slice(0, 8).join(', ') + (peopleNames.length > 8 ? '...' : '');
    return [
      `Mode: ${this.mode}`,
      `People: ${peopleNames.length} (${peopleStr})`,
      `Projects: ${this.projects.join(', ') || '(none)'}`,
      `Ambiguous flags: ${this.ambiguousFlags.join(', ') || '(none)'}`,
      `Wiki cache: ${Object.keys(this.data.wiki_cache || {}).length} entries`,
    ].join('\n');
  }
}
