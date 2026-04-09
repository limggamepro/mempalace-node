/**
 * general-extractor.ts — Extract 5 types of memories from text.
 *
 * Direct port of mempalace/general_extractor.py.
 *
 * Types:
 *   1. DECISIONS    — "we went with X because Y"
 *   2. PREFERENCES  — "always use X", "I prefer Z"
 *   3. MILESTONES   — breakthroughs, things that finally worked
 *   4. PROBLEMS     — what broke, root causes
 *   5. EMOTIONAL    — feelings, vulnerability
 *
 * No LLM required. Pure keyword/pattern heuristics.
 */

const DECISION_MARKERS = [
  "\\blet'?s (use|go with|try|pick|choose|switch to)\\b",
  "\\bwe (should|decided|chose|went with|picked|settled on)\\b",
  "\\bi'?m going (to|with)\\b",
  '\\bbetter (to|than|approach|option|choice)\\b',
  '\\binstead of\\b', '\\brather than\\b',
  '\\bthe reason (is|was|being)\\b', '\\bbecause\\b',
  '\\btrade-?off\\b', '\\bpros and cons\\b', '\\bover\\b.*\\bbecause\\b',
  '\\barchitecture\\b', '\\bapproach\\b', '\\bstrategy\\b', '\\bpattern\\b',
  '\\bstack\\b', '\\bframework\\b', '\\binfrastructure\\b',
  '\\bset (it |this )?to\\b', '\\bconfigure\\b', '\\bdefault\\b',
];

const PREFERENCE_MARKERS = [
  '\\bi prefer\\b', '\\balways use\\b', '\\bnever use\\b',
  "\\bdon'?t (ever |like to )?(use|do|mock|stub|import)\\b",
  '\\bi like (to|when|how)\\b', '\\bi hate (when|how|it when)\\b',
  "\\bplease (always|never|don'?t)\\b",
  '\\bmy (rule|preference|style|convention) is\\b',
  '\\bwe (always|never)\\b',
  '\\bfunctional\\b.*\\bstyle\\b', '\\bimperative\\b',
  '\\bsnake_?case\\b', '\\bcamel_?case\\b',
  '\\btabs\\b.*\\bspaces\\b', '\\bspaces\\b.*\\btabs\\b',
  '\\buse\\b.*\\binstead of\\b',
];

const MILESTONE_MARKERS = [
  '\\bit works\\b', '\\bit worked\\b', '\\bgot it working\\b',
  '\\bfixed\\b', '\\bsolved\\b', '\\bbreakthrough\\b',
  '\\bfigured (it )?out\\b', '\\bnailed it\\b', '\\bcracked (it|the)\\b',
  '\\bfinally\\b', '\\bfirst time\\b', '\\bfirst ever\\b',
  '\\bnever (done|been|had) before\\b',
  '\\bdiscovered\\b', '\\brealized\\b', '\\bfound (out|that)\\b', '\\bturns out\\b',
  '\\bthe key (is|was|insight)\\b', '\\bthe trick (is|was)\\b',
  '\\bnow i (understand|see|get it)\\b',
  '\\bbuilt\\b', '\\bcreated\\b', '\\bimplemented\\b', '\\bshipped\\b',
  '\\blaunched\\b', '\\bdeployed\\b', '\\breleased\\b',
  '\\bprototype\\b', '\\bproof of concept\\b', '\\bdemo\\b',
  '\\bversion \\d', '\\bv\\d+\\.\\d+',
  '\\d+x (compression|faster|slower|better|improvement|reduction)',
  '\\d+% (reduction|improvement|faster|better|smaller)',
];

const PROBLEM_MARKERS = [
  '\\b(bug|error|crash|fail|broke|broken|issue|problem)\\b',
  "\\bdoesn'?t work\\b", '\\bnot working\\b', "\\bwon'?t\\b.*\\bwork\\b",
  '\\bkeeps? (failing|crashing|breaking|erroring)\\b',
  '\\broot cause\\b', '\\bthe (problem|issue|bug) (is|was)\\b',
  '\\bturns out\\b.*\\b(was|because|due to)\\b',
  '\\bthe fix (is|was)\\b', '\\bworkaround\\b',
  "\\bthat'?s why\\b", '\\bthe reason it\\b',
  '\\bfixed (it |the |by )\\b', '\\bsolution (is|was)\\b',
  '\\bresolved\\b', '\\bpatched\\b',
  '\\bthe answer (is|was)\\b',
  '\\b(had|need) to\\b.*\\binstead\\b',
];

const EMOTION_MARKERS = [
  '\\blove\\b', '\\bscared\\b', '\\bafraid\\b', '\\bproud\\b', '\\bhurt\\b',
  '\\bhappy\\b', '\\bsad\\b', '\\bcry\\b', '\\bcrying\\b', '\\bmiss\\b',
  '\\bsorry\\b', '\\bgrateful\\b', '\\bangry\\b', '\\bworried\\b',
  '\\blonely\\b', '\\bbeautiful\\b', '\\bamazing\\b', '\\bwonderful\\b',
  'i feel', "i'm scared", 'i love you', "i'm sorry", "i can't",
  'i wish', 'i miss', 'i need',
  'never told anyone', 'nobody knows',
  '\\*[^*]+\\*',
];

const ALL_MARKERS: Record<string, string[]> = {
  decision: DECISION_MARKERS,
  preference: PREFERENCE_MARKERS,
  milestone: MILESTONE_MARKERS,
  problem: PROBLEM_MARKERS,
  emotional: EMOTION_MARKERS,
};

const POSITIVE_WORDS = new Set([
  'pride', 'proud', 'joy', 'happy', 'love', 'loving', 'beautiful', 'amazing',
  'wonderful', 'incredible', 'fantastic', 'brilliant', 'perfect', 'excited',
  'thrilled', 'grateful', 'warm', 'breakthrough', 'success', 'works',
  'working', 'solved', 'fixed', 'nailed', 'heart', 'hug', 'precious', 'adore',
]);

const NEGATIVE_WORDS = new Set([
  'bug', 'error', 'crash', 'crashing', 'crashed', 'fail', 'failed', 'failing',
  'failure', 'broken', 'broke', 'breaking', 'breaks', 'issue', 'problem',
  'wrong', 'stuck', 'blocked', 'unable', 'impossible', 'missing', 'terrible',
  'horrible', 'awful', 'worse', 'worst', 'panic', 'disaster', 'mess',
]);

function getSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const words = new Set((text.toLowerCase().match(/\b\w+\b/g) || []));
  let pos = 0, neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function hasResolution(text: string): boolean {
  const textLower = text.toLowerCase();
  const patterns = [
    '\\bfixed\\b', '\\bsolved\\b', '\\bresolved\\b', '\\bpatched\\b',
    '\\bgot it working\\b', '\\bit works\\b', '\\bnailed it\\b',
    '\\bfigured (it )?out\\b', '\\bthe (fix|answer|solution)\\b',
  ];
  return patterns.some(p => new RegExp(p).test(textLower));
}

function disambiguate(memoryType: string, text: string, scores: Record<string, number>): string {
  const sentiment = getSentiment(text);

  if (memoryType === 'problem' && hasResolution(text)) {
    if ((scores.emotional || 0) > 0 && sentiment === 'positive') return 'emotional';
    return 'milestone';
  }

  if (memoryType === 'problem' && sentiment === 'positive') {
    if ((scores.milestone || 0) > 0) return 'milestone';
    if ((scores.emotional || 0) > 0) return 'emotional';
  }

  return memoryType;
}

const CODE_LINE_PATTERNS = [
  /^\s*[$#]\s/,
  /^\s*(cd|source|echo|export|pip|npm|git|python|bash|curl|wget|mkdir|rm|cp|mv|ls|cat|grep|find|chmod|sudo|brew|docker)\s/,
  /^\s*```/,
  /^\s*(import|from|def|class|function|const|let|var|return)\s/,
  /^\s*[A-Z_]{2,}=/,
  /^\s*\|/,
  /^\s*[-]{2,}/,
  /^\s*[{}\[\]]\s*$/,
  /^\s*(if|for|while|try|except|elif|else:)\b/,
  /^\s*\w+\.\w+\(/,
  /^\s*\w+ = \w+\.\w+/,
];

function isCodeLine(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  for (const pattern of CODE_LINE_PATTERNS) {
    if (pattern.test(stripped)) return true;
  }
  let alphaCount = 0;
  for (const c of stripped) {
    if (/[a-zA-Z]/.test(c)) alphaCount++;
  }
  const alphaRatio = alphaCount / Math.max(stripped.length, 1);
  if (alphaRatio < 0.4 && stripped.length > 10) return true;
  return false;
}

function extractProse(text: string): string {
  const lines = text.split('\n');
  const prose: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!isCodeLine(line)) prose.push(line);
  }
  const result = prose.join('\n').trim();
  return result || text;
}

function scoreMarkers(text: string, markers: string[]): number {
  const textLower = text.toLowerCase();
  let score = 0;
  for (const marker of markers) {
    const matches = textLower.match(new RegExp(marker, 'g')) || [];
    score += matches.length;
  }
  return score;
}

// ── Main extraction ─────────────────────────────────────────────────────────

export interface ExtractedMemory {
  content: string;
  memory_type: 'decision' | 'preference' | 'milestone' | 'problem' | 'emotional';
  chunk_index: number;
}

/**
 * Extract memories from a text string.
 * Returns list of {content, memory_type, chunk_index}.
 */
export function extractMemories(text: string, minConfidence = 0.3): ExtractedMemory[] {
  const paragraphs = splitIntoSegments(text);
  const memories: ExtractedMemory[] = [];

  for (const para of paragraphs) {
    if (para.trim().length < 20) continue;

    const prose = extractProse(para);

    const scores: Record<string, number> = {};
    for (const [memType, markers] of Object.entries(ALL_MARKERS)) {
      const score = scoreMarkers(prose, markers);
      if (score > 0) scores[memType] = score;
    }

    if (Object.keys(scores).length === 0) continue;

    let lengthBonus = 0;
    if (para.length > 500) lengthBonus = 2;
    else if (para.length > 200) lengthBonus = 1;

    let maxType = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    const maxScore = scores[maxType] + lengthBonus;

    maxType = disambiguate(maxType, prose, scores);

    const confidence = Math.min(1.0, maxScore / 5.0);
    if (confidence < minConfidence) continue;

    memories.push({
      content: para.trim(),
      memory_type: maxType as ExtractedMemory['memory_type'],
      chunk_index: memories.length,
    });
  }

  return memories;
}

function splitIntoSegments(text: string): string[] {
  const lines = text.split('\n');

  const turnPatterns = [
    /^>\s/,
    /^(Human|User|Q)\s*:/i,
    /^(Assistant|AI|A|Claude|ChatGPT)\s*:/i,
  ];

  let turnCount = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (turnPatterns.some(p => p.test(stripped))) turnCount++;
  }

  if (turnCount >= 3) {
    return splitByTurns(lines, turnPatterns);
  }

  const paragraphs = text.split('\n\n').map(p => p.trim()).filter(Boolean);

  if (paragraphs.length <= 1 && lines.length > 20) {
    const segments: string[] = [];
    for (let i = 0; i < lines.length; i += 25) {
      const group = lines.slice(i, i + 25).join('\n').trim();
      if (group) segments.push(group);
    }
    return segments;
  }

  return paragraphs;
}

function splitByTurns(lines: string[], turnPatterns: RegExp[]): string[] {
  const segments: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const stripped = line.trim();
    const isTurn = turnPatterns.some(p => p.test(stripped));

    if (isTurn && current.length > 0) {
      segments.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) segments.push(current.join('\n'));
  return segments;
}
