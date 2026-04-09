/**
 * spellcheck.ts — Spell-correct user messages before palace filing.
 *
 * Direct port of mempalace/spellcheck.py.
 *
 * Preserves:
 *   - Technical terms (words with digits, hyphens, underscores)
 *   - CamelCase and ALL_CAPS identifiers
 *   - Known entity names
 *   - URLs and file paths
 *   - Words shorter than 4 chars
 *   - Proper nouns already capitalized in context
 *
 * Corrects:
 *   - Genuine typos in lowercase, flowing text
 *
 * Optional dependency: `nspell` + `dictionary-en` for English spellchecking.
 * Falls back to pass-through if not installed.
 *
 * Usage:
 *   import { spellcheckUserText } from 'mempalace-node/spellcheck';
 *   const corrected = spellcheckUserText("lsresdy knoe the question befor");
 *   // → "already know the question before" (best effort)
 *
 *   // Or skip nspell entirely (no-op):
 *   spellcheckUserText(text); // returns text unchanged if nspell missing
 */

// Lazy-loaded spellchecker
let speller: any = null;
let spellerInitialized = false;
let nspellAvailable = false;

async function getSpeller(): Promise<any> {
  if (spellerInitialized) return speller;
  spellerInitialized = true;

  try {
    // Dynamic require — nspell and dictionary-en are optional peer deps
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nspell = (await import(/* @vite-ignore */ 'nspell' as string).catch(() => null)) as any;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dictionary = (await import(/* @vite-ignore */ 'dictionary-en' as string).catch(() => null)) as any;

    if (!nspell || !dictionary) {
      nspellAvailable = false;
      return null;
    }

    const dictLoader = dictionary.default || dictionary;
    return new Promise((resolve) => {
      dictLoader((err: Error | null, dict: any) => {
        if (err) {
          nspellAvailable = false;
          resolve(null);
          return;
        }
        const ctor = nspell.default || nspell;
        speller = ctor(dict);
        nspellAvailable = true;
        resolve(speller);
      });
    });
  } catch {
    nspellAvailable = false;
    return null;
  }
}

// ── Patterns marking a token as "don't touch this" ───────────────────────────

const HAS_DIGIT = /\d/;
const IS_CAMEL = /[A-Z][a-z]+[A-Z]/;
const IS_ALLCAPS = /^[A-Z_@#$%^&*()+=\[\]{}|<>?.:/\\]+$/;
const IS_TECHNICAL = /[-_]/;
const IS_URL = /https?:\/\/|www\.|\/Users\/|~\/|\.[a-z]{2,4}$/i;
const IS_CODE_OR_EMOJI = /[`*_#{}[\]\\]/;

const MIN_LENGTH = 4;

function shouldSkip(token: string, knownNames: Set<string>): boolean {
  if (token.length < MIN_LENGTH) return true;
  if (HAS_DIGIT.test(token)) return true;
  if (IS_CAMEL.test(token)) return true;
  if (IS_ALLCAPS.test(token)) return true;
  if (IS_TECHNICAL.test(token)) return true;
  if (IS_URL.test(token)) return true;
  if (IS_CODE_OR_EMOJI.test(token)) return true;
  if (knownNames.has(token.toLowerCase())) return true;
  return false;
}

// ── Levenshtein distance (guard against over-aggressive correction) ──────────

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr.push(Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0),
      ));
    }
    prev = curr;
  }
  return prev[b.length];
}

// ── Core correction ──────────────────────────────────────────────────────────

/**
 * Spell-correct a user message.
 * Falls back to original text if nspell is not installed.
 */
export async function spellcheckUserText(
  text: string,
  knownNames: Set<string> = new Set(),
): Promise<string> {
  const sp = await getSpeller();
  if (!sp) return text; // nspell not available — pass through

  return text.replace(/\S+/g, (token) => {
    // Strip trailing punctuation
    const punctMatch = token.match(/[.,!?;:'")]+$/);
    const punct = punctMatch ? punctMatch[0] : '';
    const stripped = punct ? token.slice(0, -punct.length) : token;

    if (!stripped || shouldSkip(stripped, knownNames)) return token;

    // Only correct lowercase words
    if (stripped[0] !== stripped[0].toLowerCase()) return token;

    // Skip already-valid words
    if (sp.correct(stripped)) return token;

    const suggestions = sp.suggest(stripped);
    if (suggestions.length === 0) return token;

    const corrected = suggestions[0];
    if (corrected === stripped) return token;

    // Guard: don't apply if too different
    const dist = editDistance(stripped, corrected);
    const maxEdits = stripped.length <= 7 ? 2 : 3;
    if (dist > maxEdits) return token;

    return corrected + punct;
  });
}

/**
 * Spell-correct a single transcript line.
 * Only touches lines starting with '>' (user turns).
 */
export async function spellcheckTranscriptLine(line: string): Promise<string> {
  const stripped = line.replace(/^\s+/, '');
  if (!stripped.startsWith('>')) return line;

  const prefixLen = line.length - stripped.length + 2; // '> '
  const message = line.slice(prefixLen);
  if (!message.trim()) return line;

  const corrected = await spellcheckUserText(message);
  return line.slice(0, prefixLen) + corrected;
}

/**
 * Spell-correct all user turns in a full transcript.
 * Only lines starting with '>' are touched.
 */
export async function spellcheckTranscript(content: string): Promise<string> {
  const lines = content.split('\n');
  const corrected = await Promise.all(lines.map(spellcheckTranscriptLine));
  return corrected.join('\n');
}

/** Whether nspell is installed and ready (after first call) */
export function isSpellcheckAvailable(): boolean {
  return nspellAvailable;
}
