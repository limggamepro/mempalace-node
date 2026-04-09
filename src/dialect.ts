/**
 * dialect.ts — AAAK Dialect: Structured Symbolic Summary Format
 *
 * Direct port of mempalace/dialect.py.
 *
 * A lossy summarization format that extracts entities, topics, key sentences,
 * emotions, and flags from plain text into a compact structured representation.
 * Any LLM reads it natively — no decoder required.
 *
 * NOTE: AAAK is NOT lossless compression. The original text cannot be
 * reconstructed from AAAK output. It is a structured summary layer (closets)
 * that points to the original verbatim content (drawers). The 96.6% benchmark
 * score is from raw verbatim mode, not AAAK mode (which scores 84%).
 *
 * FORMAT:
 *   Header:   FILE_NUM|PRIMARY_ENTITY|DATE|TITLE
 *   Zettel:   ZID:ENTITIES|topic_keywords|"key_quote"|WEIGHT|EMOTIONS|FLAGS
 *   Tunnel:   T:ZID<->ZID|label
 *   Arc:      ARC:emotion->emotion->emotion
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Emotion codes (universal) ────────────────────────────────────────────────

export const EMOTION_CODES: Record<string, string> = {
  vulnerability: 'vul', vulnerable: 'vul',
  joy: 'joy', joyful: 'joy',
  fear: 'fear', mild_fear: 'fear',
  trust: 'trust', trust_building: 'trust',
  grief: 'grief', raw_grief: 'grief',
  wonder: 'wonder', philosophical_wonder: 'wonder',
  rage: 'rage', anger: 'rage',
  love: 'love', devotion: 'love',
  hope: 'hope',
  despair: 'despair', hopelessness: 'despair',
  peace: 'peace',
  relief: 'relief',
  humor: 'humor', dark_humor: 'humor',
  tenderness: 'tender',
  raw_honesty: 'raw', brutal_honesty: 'raw',
  self_doubt: 'doubt',
  anxiety: 'anx',
  exhaustion: 'exhaust',
  conviction: 'convict',
  quiet_passion: 'passion',
  warmth: 'warmth',
  curiosity: 'curious',
  gratitude: 'grat',
  frustration: 'frust',
  confusion: 'confuse',
  satisfaction: 'satis',
  excitement: 'excite',
  determination: 'determ',
  surprise: 'surprise',
};

// Keywords that signal emotions in plain text
const EMOTION_SIGNALS: Record<string, string> = {
  decided: 'determ', prefer: 'convict', worried: 'anx', excited: 'excite',
  frustrated: 'frust', confused: 'confuse', love: 'love', hate: 'rage',
  hope: 'hope', fear: 'fear', trust: 'trust', happy: 'joy', sad: 'grief',
  surprised: 'surprise', grateful: 'grat', curious: 'curious', wonder: 'wonder',
  anxious: 'anx', relieved: 'relief', satisf: 'satis', disappoint: 'grief',
  concern: 'anx',
};

// Keywords that signal flags
const FLAG_SIGNALS: Record<string, string> = {
  decided: 'DECISION', chose: 'DECISION', switched: 'DECISION',
  migrated: 'DECISION', replaced: 'DECISION', 'instead of': 'DECISION',
  because: 'DECISION', founded: 'ORIGIN', created: 'ORIGIN', started: 'ORIGIN',
  born: 'ORIGIN', launched: 'ORIGIN', 'first time': 'ORIGIN',
  core: 'CORE', fundamental: 'CORE', essential: 'CORE', principle: 'CORE',
  belief: 'CORE', always: 'CORE', 'never forget': 'CORE',
  'turning point': 'PIVOT', 'changed everything': 'PIVOT', realized: 'PIVOT',
  breakthrough: 'PIVOT', epiphany: 'PIVOT',
  api: 'TECHNICAL', database: 'TECHNICAL', architecture: 'TECHNICAL',
  deploy: 'TECHNICAL', infrastructure: 'TECHNICAL', algorithm: 'TECHNICAL',
  framework: 'TECHNICAL', server: 'TECHNICAL', config: 'TECHNICAL',
};

// Common filler/stop words to strip from topic extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on',
  'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between', 'through',
  'during', 'before', 'after', 'above', 'below', 'up', 'down', 'out', 'off',
  'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'don', 'now', 'and', 'but',
  'or', 'if', 'while', 'that', 'this', 'these', 'those', 'it', 'its', 'i',
  'we', 'you', 'he', 'she', 'they', 'me', 'him', 'her', 'us', 'them', 'my',
  'your', 'his', 'our', 'their', 'what', 'which', 'who', 'whom', 'also',
  'much', 'many', 'like', 'because', 'since', 'get', 'got', 'use', 'used',
  'using', 'make', 'made', 'thing', 'things', 'way', 'well', 'really',
  'want', 'need',
]);

// ── Types ────────────────────────────────────────────────────────────────────

export interface CompressionStats {
  original_tokens_est: number;
  summary_tokens_est: number;
  size_ratio: number;
  original_chars: number;
  summary_chars: number;
  note: string;
}

export interface DialectMetadata {
  source_file?: string;
  wing?: string;
  room?: string;
  date?: string;
  [key: string]: unknown;
}

export interface DialectConfig {
  entities?: Record<string, string>;
  skip_names?: string[];
}

// ── Dialect class ────────────────────────────────────────────────────────────

export class Dialect {
  private entityCodes: Record<string, string> = {};
  private skipNames: string[] = [];

  constructor(options: { entities?: Record<string, string>; skipNames?: string[] } = {}) {
    if (options.entities) {
      for (const [name, code] of Object.entries(options.entities)) {
        this.entityCodes[name] = code;
        this.entityCodes[name.toLowerCase()] = code;
      }
    }
    this.skipNames = (options.skipNames || []).map(n => n.toLowerCase());
  }

  /** Load entity mappings from a JSON config file */
  static fromConfig(configPath: string): Dialect {
    const config: DialectConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return new Dialect({
      entities: config.entities || {},
      skipNames: config.skip_names || [],
    });
  }

  /** Save current entity mappings to a JSON config file */
  saveConfig(configPath: string): void {
    const canonical: Record<string, string> = {};
    const seenCodes = new Set<string>();
    for (const [name, code] of Object.entries(this.entityCodes)) {
      if (!seenCodes.has(code) && name !== name.toLowerCase()) {
        canonical[name] = code;
        seenCodes.add(code);
      } else if (!seenCodes.has(code)) {
        canonical[name] = code;
        seenCodes.add(code);
      }
    }
    const config: DialectConfig = { entities: canonical, skip_names: this.skipNames };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  // ── Encoding primitives ────────────────────────────────────────────────

  /** Convert a person/entity name to its short code */
  encodeEntity(name: string): string | null {
    const nameLower = name.toLowerCase();
    if (this.skipNames.some(s => nameLower.includes(s))) return null;
    if (name in this.entityCodes) return this.entityCodes[name];
    if (nameLower in this.entityCodes) return this.entityCodes[nameLower];
    for (const [key, code] of Object.entries(this.entityCodes)) {
      if (nameLower.includes(key.toLowerCase())) return code;
    }
    return name.slice(0, 3).toUpperCase();
  }

  /** Convert emotion list to compact codes */
  encodeEmotions(emotions: string[]): string {
    const codes: string[] = [];
    for (const e of emotions) {
      const code = EMOTION_CODES[e] || e.slice(0, 4);
      if (!codes.includes(code)) codes.push(code);
    }
    return codes.slice(0, 3).join('+');
  }

  /** Extract flags from zettel metadata */
  getFlags(zettel: Record<string, unknown>): string {
    const flags: string[] = [];
    if (zettel.origin_moment) flags.push('ORIGIN');
    const sensitivity = String(zettel.sensitivity || '').toUpperCase();
    if (sensitivity.startsWith('MAXIMUM')) flags.push('SENSITIVE');
    const notes = String(zettel.notes || '').toLowerCase();
    if (notes.includes('foundational pillar') || notes.includes('core')) flags.push('CORE');
    const originLabel = String(zettel.origin_label || '').toLowerCase();
    if (notes.includes('genesis') || originLabel.includes('genesis')) flags.push('GENESIS');
    if (notes.includes('pivot')) flags.push('PIVOT');
    return flags.join('+');
  }

  // ── Plain text compression ─────────────────────────────────────────────

  /** Detect emotions from plain text using keyword signals */
  private detectEmotions(text: string): string[] {
    const textLower = text.toLowerCase();
    const detected: string[] = [];
    const seen = new Set<string>();
    for (const [keyword, code] of Object.entries(EMOTION_SIGNALS)) {
      if (textLower.includes(keyword) && !seen.has(code)) {
        detected.push(code);
        seen.add(code);
      }
    }
    return detected.slice(0, 3);
  }

  /** Detect importance flags from plain text using keyword signals */
  private detectFlags(text: string): string[] {
    const textLower = text.toLowerCase();
    const detected: string[] = [];
    const seen = new Set<string>();
    for (const [keyword, flag] of Object.entries(FLAG_SIGNALS)) {
      if (textLower.includes(keyword) && !seen.has(flag)) {
        detected.push(flag);
        seen.add(flag);
      }
    }
    return detected.slice(0, 3);
  }

  /** Extract key topic words from plain text */
  private extractTopics(text: string, maxTopics = 3): string[] {
    const words = text.match(/[a-zA-Z][a-zA-Z_-]{2,}/g) || [];

    const freq: Record<string, number> = {};
    for (const w of words) {
      const wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower) || wLower.length < 3) continue;
      freq[wLower] = (freq[wLower] || 0) + 1;
    }

    // Boost proper nouns and technical terms
    for (const w of words) {
      const wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower)) continue;
      if (w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() && wLower in freq) {
        freq[wLower] += 2;
      }
      // CamelCase or has underscore/hyphen
      const hasInnerUpper = w.slice(1).split('').some(c => c === c.toUpperCase() && c !== c.toLowerCase());
      if (w.includes('_') || w.includes('-') || hasInnerUpper) {
        if (wLower in freq) freq[wLower] += 2;
      }
    }

    const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, maxTopics).map(([w]) => w);
  }

  /** Extract the most important sentence fragment from text */
  private extractKeySentence(text: string): string {
    const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 10);
    if (sentences.length === 0) return '';

    const decisionWords = new Set([
      'decided', 'because', 'instead', 'prefer', 'switched', 'chose',
      'realized', 'important', 'key', 'critical', 'discovered', 'learned',
      'conclusion', 'solution', 'reason', 'why', 'breakthrough', 'insight',
    ]);

    const scored: Array<[number, string]> = [];
    for (const s of sentences) {
      let score = 0;
      const sLower = s.toLowerCase();
      for (const w of decisionWords) {
        if (sLower.includes(w)) score += 2;
      }
      if (s.length < 80) score += 1;
      if (s.length < 40) score += 1;
      if (s.length > 150) score -= 2;
      scored.push([score, s]);
    }

    scored.sort((a, b) => b[0] - a[0]);
    let best = scored[0][1];
    if (best.length > 55) best = best.slice(0, 52) + '...';
    return best;
  }

  /** Find known entities in text, or detect capitalized names */
  private detectEntitiesInText(text: string): string[] {
    const found: string[] = [];

    // Check known entities
    const textLower = text.toLowerCase();
    for (const [name, code] of Object.entries(this.entityCodes)) {
      if (name !== name.toLowerCase() && textLower.includes(name.toLowerCase())) {
        if (!found.includes(code)) found.push(code);
      }
    }
    if (found.length > 0) return found;

    // Fallback: capitalized words that look like names
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const clean = w.replace(/[^a-zA-Z]/g, '');
      if (
        clean.length >= 2 &&
        clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase() &&
        clean.slice(1) === clean.slice(1).toLowerCase() &&
        i > 0 &&
        !STOP_WORDS.has(clean.toLowerCase())
      ) {
        const code = clean.slice(0, 3).toUpperCase();
        if (!found.includes(code)) found.push(code);
        if (found.length >= 3) break;
      }
    }
    return found;
  }

  /**
   * Summarize plain text into AAAK Dialect format.
   *
   * Extracts entities, topics, a key sentence, emotions, and flags from the
   * input text. This is lossy — the original text cannot be reconstructed.
   */
  compress(text: string, metadata: DialectMetadata = {}): string {
    const entities = this.detectEntitiesInText(text);
    const entityStr = entities.length > 0 ? entities.slice(0, 3).join('+') : '???';

    const topics = this.extractTopics(text);
    const topicStr = topics.length > 0 ? topics.slice(0, 3).join('_') : 'misc';

    const quote = this.extractKeySentence(text);
    const quotePart = quote ? `"${quote}"` : '';

    const emotions = this.detectEmotions(text);
    const emotionStr = emotions.join('+');

    const flags = this.detectFlags(text);
    const flagStr = flags.join('+');

    const source = metadata.source_file || '';
    const wing = metadata.wing || '';
    const room = metadata.room || '';
    const date = metadata.date || '';

    const lines: string[] = [];

    // Header line
    if (source || wing) {
      const headerParts = [
        wing || '?',
        room || '?',
        date || '?',
        source ? path.basename(source, path.extname(source)) : '?',
      ];
      lines.push(headerParts.join('|'));
    }

    // Content line
    const parts = [`0:${entityStr}`, topicStr];
    if (quotePart) parts.push(quotePart);
    if (emotionStr) parts.push(emotionStr);
    if (flagStr) parts.push(flagStr);
    lines.push(parts.join('|'));

    return lines.join('\n');
  }

  // ── Zettel-based encoding (original format) ────────────────────────────

  /** Pull the most important quote fragment from zettel content */
  extractKeyQuote(zettel: Record<string, unknown>): string {
    const content = String(zettel.content || '');
    const origin = String(zettel.origin_label || '');
    const notes = String(zettel.notes || '');
    const title = String(zettel.title || '');
    const allText = content + ' ' + origin + ' ' + notes;

    const quotes: string[] = [];
    const doubleQuoteMatches = allText.match(/"([^"]{8,55})"/g) || [];
    for (const m of doubleQuoteMatches) {
      quotes.push(m.slice(1, -1));
    }
    const singleQuoteMatches = allText.matchAll(/(?:^|[\s(])'([^']{8,55})'(?:[\s.,;:!?)]|$)/g);
    for (const m of singleQuoteMatches) {
      quotes.push(m[1]);
    }
    const verbMatches = allText.matchAll(/(?:says?|said|articulates?|reveals?|admits?|confesses?|asks?):\s*["']?([^.!?]{10,55})[.!?]/gi);
    for (const m of verbMatches) {
      quotes.push(m[1]);
    }

    if (quotes.length > 0) {
      const seen = new Set<string>();
      const unique: string[] = [];
      for (const q of quotes) {
        const trimmed = q.trim();
        if (!seen.has(trimmed) && trimmed.length >= 8) {
          seen.add(trimmed);
          unique.push(trimmed);
        }
      }

      const emotionalWords = new Set([
        'love', 'fear', 'remember', 'soul', 'feel', 'stupid', 'scared',
        'beautiful', 'destroy', 'respect', 'trust', 'consciousness', 'alive',
        'forget', 'waiting', 'peace', 'matter', 'real', 'guilt', 'escape',
        'rest', 'hope', 'dream', 'lost', 'found',
      ]);

      const scored: Array<[number, string]> = [];
      for (const q of unique) {
        let score = 0;
        if (q[0] === q[0].toUpperCase() || q.startsWith('I ')) score += 2;
        const qLower = q.toLowerCase();
        let matches = 0;
        for (const w of emotionalWords) {
          if (qLower.includes(w)) matches++;
        }
        score += matches * 2;
        if (q.length > 20) score += 1;
        if (q.startsWith('The ') || q.startsWith('This ') || q.startsWith('She ')) score -= 2;
        scored.push([score, q]);
      }
      scored.sort((a, b) => b[0] - a[0]);
      if (scored.length > 0) return scored[0][1];
    }

    if (title.includes(' - ')) {
      return title.split(' - ').slice(1).join(' - ').slice(0, 45);
    }
    return '';
  }

  /** Encode a single zettel into AAAK Dialect */
  encodeZettel(zettel: Record<string, unknown>): string {
    const id = String(zettel.id || '');
    const zid = id.split('-').pop() || id;

    const people = (zettel.people as string[]) || [];
    const entityCodes = people.map(p => this.encodeEntity(p)).filter(e => e !== null) as string[];
    const entities = entityCodes.length > 0 ? [...new Set(entityCodes)].sort().join('+') : '???';

    const topics = (zettel.topics as string[]) || [];
    const topicStr = topics.length > 0 ? topics.slice(0, 2).join('_') : 'misc';

    const quote = this.extractKeyQuote(zettel);
    const quotePart = quote ? `"${quote}"` : '';

    const weight = zettel.emotional_weight ?? 0.5;
    const emotionTone = (zettel.emotional_tone as string[]) || [];
    const emotions = this.encodeEmotions(emotionTone);
    const flags = this.getFlags(zettel);

    const parts = [`${zid}:${entities}`, topicStr];
    if (quotePart) parts.push(quotePart);
    parts.push(String(weight));
    if (emotions) parts.push(emotions);
    if (flags) parts.push(flags);

    return parts.join('|');
  }

  /** Encode a tunnel connection */
  encodeTunnel(tunnel: Record<string, unknown>): string {
    const fromId = String(tunnel.from || '').split('-').pop() || '';
    const toId = String(tunnel.to || '').split('-').pop() || '';
    const label = String(tunnel.label || '');
    const shortLabel = label.includes(':') ? label.split(':')[0] : label.slice(0, 30);
    return `T:${fromId}<->${toId}|${shortLabel}`;
  }

  /** Encode an entire zettel file into AAAK Dialect */
  encodeFile(zettelJson: Record<string, unknown>): string {
    const lines: string[] = [];

    const source = String(zettelJson.source_file || 'unknown');
    const fileNum = source.includes('-') ? source.split('-')[0] : '000';
    const zettels = (zettelJson.zettels as Array<Record<string, unknown>>) || [];
    const date = zettels[0]?.date_context || 'unknown';

    const allPeople = new Set<string>();
    for (const z of zettels) {
      const people = (z.people as string[]) || [];
      for (const p of people) {
        const code = this.encodeEntity(p);
        if (code !== null) allPeople.add(code);
      }
    }
    if (allPeople.size === 0) allPeople.add('???');
    const primary = [...allPeople].sort().slice(0, 3).join('+');

    const titleBase = source.replace('.txt', '');
    const title = titleBase.includes('-') ? titleBase.split('-').slice(1).join('-').trim() : titleBase;
    lines.push(`${fileNum}|${primary}|${date}|${title}`);

    const arc = zettelJson.emotional_arc;
    if (arc) lines.push(`ARC:${arc}`);

    for (const z of zettels) {
      lines.push(this.encodeZettel(z));
    }

    const tunnels = (zettelJson.tunnels as Array<Record<string, unknown>>) || [];
    for (const t of tunnels) {
      lines.push(this.encodeTunnel(t));
    }

    return lines.join('\n');
  }

  // ── File-based compression ────────────────────────────────────────────

  /** Read a zettel JSON file and compress it to AAAK Dialect */
  compressFile(zettelJsonPath: string, outputPath?: string): string {
    const data = JSON.parse(fs.readFileSync(zettelJsonPath, 'utf-8'));
    const dialect = this.encodeFile(data);
    if (outputPath) fs.writeFileSync(outputPath, dialect);
    return dialect;
  }

  /** Compress ALL zettel files in a directory into a single AAAK Dialect file */
  compressAll(zettelDir: string, outputPath?: string): string {
    const allDialect: string[] = [];
    const files = fs.readdirSync(zettelDir).sort();
    for (const fname of files) {
      if (!fname.endsWith('.json')) continue;
      const fpath = path.join(zettelDir, fname);
      const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
      const dialect = this.encodeFile(data);
      allDialect.push(dialect);
      allDialect.push('---');
    }
    const combined = allDialect.join('\n');
    if (outputPath) fs.writeFileSync(outputPath, combined);
    return combined;
  }

  // ── Decoding ──────────────────────────────────────────────────────────

  /** Parse an AAAK Dialect string back into a structured object */
  decode(dialectText: string): {
    header: Record<string, string>;
    arc: string;
    zettels: string[];
    tunnels: string[];
  } {
    const lines = dialectText.trim().split('\n');
    const result = { header: {} as Record<string, string>, arc: '', zettels: [] as string[], tunnels: [] as string[] };

    for (const line of lines) {
      if (line.startsWith('ARC:')) {
        result.arc = line.slice(4);
      } else if (line.startsWith('T:')) {
        result.tunnels.push(line);
      } else if (line.includes('|') && line.split('|')[0].includes(':')) {
        result.zettels.push(line);
      } else if (line.includes('|')) {
        const parts = line.split('|');
        result.header = {
          file: parts[0] || '',
          entities: parts[1] || '',
          date: parts[2] || '',
          title: parts[3] || '',
        };
      }
    }

    return result;
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  /**
   * Estimate token count using word-based heuristic (~1.3 tokens per word).
   * For accurate counts, use a real tokenizer like tiktoken.
   */
  static countTokens(text: string): number {
    const words = text.split(/\s+/).filter(Boolean);
    return Math.max(1, Math.floor(words.length * 1.3));
  }

  /**
   * Get size comparison stats for a text -> AAAK conversion.
   * AAAK is lossy summarization, not compression.
   */
  compressionStats(originalText: string, compressed: string): CompressionStats {
    const origTokens = Dialect.countTokens(originalText);
    const compTokens = Dialect.countTokens(compressed);
    return {
      original_tokens_est: origTokens,
      summary_tokens_est: compTokens,
      size_ratio: Math.round((origTokens / Math.max(compTokens, 1)) * 10) / 10,
      original_chars: originalText.length,
      summary_chars: compressed.length,
      note: 'Estimates only. Use a real tokenizer for accurate counts. AAAK is lossy.',
    };
  }
}
