/**
 * normalize.ts — Convert any chat export format to MemPalace transcript format.
 *
 * Direct port of mempalace/normalize.py.
 *
 * Supported:
 *   - Plain text with > markers (pass through)
 *   - Claude.ai JSON export
 *   - ChatGPT conversations.json
 *   - Claude Code JSONL
 *   - OpenAI Codex CLI JSONL
 *   - Slack JSON export
 *   - Plain text (pass through for paragraph chunking)
 *
 * No API key. No internet. Everything local.
 */

import * as fs from 'fs';
import * as path from 'path';

type Message = [role: 'user' | 'assistant', text: string];

/**
 * Load a file and normalize to transcript format if it's a chat export.
 * Plain text files pass through unchanged.
 */
export function normalize(filepath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filepath, 'utf-8');
  } catch (e) {
    throw new Error(`Could not read ${filepath}: ${e}`);
  }

  if (!content.trim()) return content;

  // Already has > markers — pass through
  const lines = content.split('\n');
  const quoteCount = lines.filter(line => line.trim().startsWith('>')).length;
  if (quoteCount >= 3) return content;

  // Try JSON normalization
  const ext = path.extname(filepath).toLowerCase();
  if (ext === '.json' || ext === '.jsonl' || content.trim()[0] === '{' || content.trim()[0] === '[') {
    const normalized = tryNormalizeJson(content);
    if (normalized) return normalized;
  }

  return content;
}

function tryNormalizeJson(content: string): string | null {
  // Try OpenClaw first (most specific format)
  let normalized = tryOpenClawJsonl(content);
  if (normalized) return normalized;

  normalized = tryClaudeCodeJsonl(content);
  if (normalized) return normalized;

  normalized = tryCodexJsonl(content);
  if (normalized) return normalized;

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }

  for (const parser of [tryClaudeAiJson, tryChatgptJson, trySlackJson]) {
    normalized = parser(data);
    if (normalized) return normalized;
  }

  return null;
}

/**
 * OpenClaw JSONL sessions.
 * Format: each line is { type, id, parentId, timestamp, ... }
 *   - type: "session" — top-level metadata (id, cwd, version)
 *   - type: "message" — actual exchange, with nested message.role and message.content[]
 *     - content blocks: { type: "text" | "thinking" | "toolCall", ... }
 */
function tryOpenClawJsonl(content: string): string | null {
  const lines = content.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  // Detect: first line should be a session metadata entry
  let firstEntry: Record<string, unknown>;
  try { firstEntry = JSON.parse(lines[0]); } catch { return null; }
  if (firstEntry.type !== 'session' || !firstEntry.cwd) return null;

  const messages: Message[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'message') continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role as string;
    const contentBlocks = msg.content;
    if (!Array.isArray(contentBlocks)) continue;

    // Skip errored assistant turns
    if (role === 'assistant' && msg.stopReason === 'error') continue;

    const parts: string[] = [];
    for (const block of contentBlocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      const blockType = b.type as string;

      if (blockType === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (blockType === 'toolCall' && b.name && b.arguments) {
        // Render tool call as a compact string
        const args = typeof b.arguments === 'object' ? JSON.stringify(b.arguments) : String(b.arguments);
        parts.push(`[${b.name as string}] ${args}`);
      } else if (blockType === 'thinking' && typeof b.thinking === 'string') {
        // Optionally include thinking blocks (commented out by default — too noisy)
        // parts.push(`(thinking: ${b.thinking})`);
      }
    }

    const text = parts.join(' ').trim();
    if (!text) continue;

    if (role === 'user') {
      messages.push(['user', text]);
    } else if (role === 'assistant') {
      messages.push(['assistant', text]);
    }
  }

  return messages.length >= 2 ? messagesToTranscript(messages) : null;
}

/** Claude Code JSONL sessions */
function tryClaudeCodeJsonl(content: string): string | null {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const messages: Message[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry !== 'object' || entry === null) continue;

    const msgType = entry.type as string || '';
    const message = entry.message as Record<string, unknown> || {};

    if (msgType === 'human' || msgType === 'user') {
      const text = extractContent(message.content);
      if (text) messages.push(['user', text]);
    } else if (msgType === 'assistant') {
      const text = extractContent(message.content);
      if (text) messages.push(['assistant', text]);
    }
  }

  return messages.length >= 2 ? messagesToTranscript(messages) : null;
}

/** OpenAI Codex CLI sessions */
function tryCodexJsonl(content: string): string | null {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const messages: Message[] = [];
  let hasSessionMeta = false;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry !== 'object' || entry === null) continue;

    const entryType = entry.type as string || '';
    if (entryType === 'session_meta') { hasSessionMeta = true; continue; }
    if (entryType !== 'event_msg') continue;

    const payload = entry.payload as Record<string, unknown> || {};
    if (typeof payload !== 'object') continue;

    const payloadType = payload.type as string || '';
    const msg = payload.message;
    if (typeof msg !== 'string') continue;
    const text = msg.trim();
    if (!text) continue;

    if (payloadType === 'user_message') messages.push(['user', text]);
    else if (payloadType === 'agent_message') messages.push(['assistant', text]);
  }

  return messages.length >= 2 && hasSessionMeta ? messagesToTranscript(messages) : null;
}

/** Claude.ai JSON export: flat messages list or privacy export with chat_messages */
function tryClaudeAiJson(data: unknown): string | null {
  let items: unknown[];

  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    items = (d.messages || d.chat_messages || []) as unknown[];
  } else if (Array.isArray(data)) {
    items = data;
  } else {
    return null;
  }

  // Privacy export: array of conversation objects with chat_messages inside each
  if (items.length > 0 && typeof items[0] === 'object' && items[0] !== null && 'chat_messages' in (items[0] as Record<string, unknown>)) {
    const allMessages: Message[] = [];
    for (const convo of items) {
      if (typeof convo !== 'object' || convo === null) continue;
      const chatMsgs = (convo as Record<string, unknown>).chat_messages as unknown[] || [];
      for (const item of chatMsgs) {
        if (typeof item !== 'object' || item === null) continue;
        const it = item as Record<string, unknown>;
        const role = it.role as string || '';
        const text = extractContent(it.content);
        if ((role === 'user' || role === 'human') && text) allMessages.push(['user', text]);
        else if ((role === 'assistant' || role === 'ai') && text) allMessages.push(['assistant', text]);
      }
    }
    return allMessages.length >= 2 ? messagesToTranscript(allMessages) : null;
  }

  // Flat messages list
  const messages: Message[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as Record<string, unknown>;
    const role = it.role as string || '';
    const text = extractContent(it.content);
    if ((role === 'user' || role === 'human') && text) messages.push(['user', text]);
    else if ((role === 'assistant' || role === 'ai') && text) messages.push(['assistant', text]);
  }
  return messages.length >= 2 ? messagesToTranscript(messages) : null;
}

/** ChatGPT conversations.json with mapping tree */
function tryChatgptJson(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('mapping' in (data as Record<string, unknown>))) return null;

  const mapping = (data as Record<string, unknown>).mapping as Record<string, Record<string, unknown>>;
  const messages: Message[] = [];

  // Find root node
  let rootId: string | null = null;
  let fallbackRoot: string | null = null;
  for (const [nodeId, node] of Object.entries(mapping)) {
    if (node.parent === null || node.parent === undefined) {
      if (!node.message) { rootId = nodeId; break; }
      else if (!fallbackRoot) fallbackRoot = nodeId;
    }
  }
  if (!rootId) rootId = fallbackRoot;

  if (rootId) {
    let currentId: string | null = rootId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node: Record<string, unknown> = mapping[currentId] || {};
      const msg = node.message as Record<string, unknown> | undefined;
      if (msg) {
        const role = ((msg.author as Record<string, unknown>)?.role as string) || '';
        const contentObj = msg.content as Record<string, unknown> || {};
        const parts = (Array.isArray(contentObj) ? contentObj : (contentObj.parts as unknown[]) || []) as unknown[];
        const text = parts.filter((p): p is string => typeof p === 'string').join(' ').trim();
        if (role === 'user' && text) messages.push(['user', text]);
        else if (role === 'assistant' && text) messages.push(['assistant', text]);
      }
      const children: string[] = (node.children as string[]) || [];
      currentId = children.length > 0 ? children[0] : null;
    }
  }

  return messages.length >= 2 ? messagesToTranscript(messages) : null;
}

/** Slack channel export */
function trySlackJson(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  const messages: Message[] = [];
  const seenUsers: Record<string, 'user' | 'assistant'> = {};
  let lastRole: 'user' | 'assistant' | null = null;

  for (const item of data) {
    if (typeof item !== 'object' || item === null || (item as Record<string, unknown>).type !== 'message') continue;
    const it = item as Record<string, unknown>;
    const userId = (it.user || it.username || '') as string;
    const text = ((it.text || '') as string).trim();
    if (!text || !userId) continue;

    if (!(userId in seenUsers)) {
      if (Object.keys(seenUsers).length === 0) seenUsers[userId] = 'user';
      else if (lastRole === 'user') seenUsers[userId] = 'assistant';
      else seenUsers[userId] = 'user';
    }
    lastRole = seenUsers[userId];
    messages.push([seenUsers[userId], text]);
  }

  return messages.length >= 2 ? messagesToTranscript(messages) : null;
}

/** Pull text from content — handles str, list of blocks, or dict */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text') {
        parts.push(((item as Record<string, unknown>).text as string) || '');
      }
    }
    return parts.join(' ').trim();
  }
  if (typeof content === 'object' && content !== null) {
    return ((content as Record<string, unknown>).text as string || '').trim();
  }
  return '';
}

/** Convert [(role, text), ...] to transcript format with > markers */
function messagesToTranscript(messages: Message[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < messages.length) {
    const [role, text] = messages[i];
    if (role === 'user') {
      lines.push(`> ${text}`);
      if (i + 1 < messages.length && messages[i + 1][0] === 'assistant') {
        lines.push(messages[i + 1][1]);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      lines.push(text);
      i += 1;
    }
    lines.push('');
  }
  return lines.join('\n');
}
