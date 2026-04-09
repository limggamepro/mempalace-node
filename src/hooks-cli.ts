/**
 * hooks-cli.ts — Hook logic for MemPalace.
 *
 * Direct port of mempalace/hooks_cli.py.
 *
 * Reads JSON from stdin, outputs JSON to stdout.
 * Supported hooks: session-start, stop, precompact
 * Supported harnesses: claude-code, codex
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const SAVE_INTERVAL = 15;
const STATE_DIR = path.join(os.homedir(), '.mempalace', 'hook_state');

const STOP_BLOCK_REASON =
  'AUTO-SAVE checkpoint. Save key topics, decisions, quotes, and code ' +
  'from this session to your memory system. Organize into appropriate ' +
  'categories. Use verbatim quotes where possible. Continue conversation ' +
  'after saving.';

const PRECOMPACT_BLOCK_REASON =
  'COMPACTION IMMINENT. Save ALL topics, decisions, quotes, code, and ' +
  'important context from this session to your memory system. Be thorough ' +
  '— after compaction, detailed context will be lost. Organize into ' +
  'appropriate categories. Use verbatim quotes where possible. Save ' +
  'everything, then allow compaction to proceed.';

export type HookName = 'session-start' | 'stop' | 'precompact';
export type Harness = 'claude-code' | 'codex';

const SUPPORTED_HARNESSES = new Set<Harness>(['claude-code', 'codex']);

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
}

function countHumanMessages(transcriptPath: string): number {
  const expanded = transcriptPath.startsWith('~') ? path.join(os.homedir(), transcriptPath.slice(1)) : transcriptPath;
  if (!fs.existsSync(expanded)) return 0;

  let count = 0;
  try {
    const content = fs.readFileSync(expanded, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || {};
        if (typeof msg !== 'object' || msg.role !== 'user') continue;

        const messageContent = msg.content || '';
        let textCheck = '';
        if (typeof messageContent === 'string') {
          textCheck = messageContent;
        } else if (Array.isArray(messageContent)) {
          textCheck = messageContent
            .filter((b: any) => typeof b === 'object' && b !== null)
            .map((b: any) => b.text || '')
            .join(' ');
        }
        if (textCheck.includes('<command-message>')) continue;
        count++;
      } catch { /* skip parse errors */ }
    }
  } catch {
    return 0;
  }
  return count;
}

function logHook(message: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const logPath = path.join(STATE_DIR, 'hook.log');
    const timestamp = new Date().toTimeString().slice(0, 8);
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch { /* ignore */ }
}

function output(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function maybeAutoIngest(): void {
  const mempalDir = process.env.MEMPAL_DIR || '';
  if (mempalDir && fs.existsSync(mempalDir) && fs.statSync(mempalDir).isDirectory()) {
    try {
      const logPath = path.join(STATE_DIR, 'hook.log');
      const logFd = fs.openSync(logPath, 'a');
      // Run mempalace mine via the Node.js library — programmatic, not subprocess
      // This is a fire-and-forget background ingest
      spawn(process.execPath, ['-e', `require('mempalace-node').mine({projectDir: '${mempalDir}', palacePath: require('os').homedir() + '/.mempalace/palace'}).then(() => process.exit(0))`], {
        stdio: ['ignore', logFd, logFd],
        detached: true,
      }).unref();
    } catch { /* ignore */ }
  }
}

interface ParsedInput {
  session_id: string;
  stop_hook_active: boolean;
  transcript_path: string;
}

function parseHarnessInput(data: Record<string, unknown>, harness: string): ParsedInput {
  if (!SUPPORTED_HARNESSES.has(harness as Harness)) {
    process.stderr.write(`Unknown harness: ${harness}\n`);
    process.exit(1);
  }
  return {
    session_id: sanitizeSessionId(String(data.session_id || 'unknown')),
    stop_hook_active: Boolean(data.stop_hook_active),
    transcript_path: String(data.transcript_path || ''),
  };
}

export function hookStop(data: Record<string, unknown>, harness: string): void {
  const parsed = parseHarnessInput(data, harness);
  const { session_id, stop_hook_active, transcript_path } = parsed;

  if (stop_hook_active === true || String(stop_hook_active).toLowerCase() === 'true') {
    output({});
    return;
  }

  const exchangeCount = countHumanMessages(transcript_path);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lastSaveFile = path.join(STATE_DIR, `${session_id}_last_save`);
  let lastSave = 0;
  if (fs.existsSync(lastSaveFile)) {
    try { lastSave = parseInt(fs.readFileSync(lastSaveFile, 'utf-8').trim(), 10) || 0; } catch { /* ignore */ }
  }

  const sinceLast = exchangeCount - lastSave;
  logHook(`Session ${session_id}: ${exchangeCount} exchanges, ${sinceLast} since last save`);

  if (sinceLast >= SAVE_INTERVAL && exchangeCount > 0) {
    try { fs.writeFileSync(lastSaveFile, String(exchangeCount)); } catch { /* ignore */ }
    logHook(`TRIGGERING SAVE at exchange ${exchangeCount}`);
    maybeAutoIngest();
    output({ decision: 'block', reason: STOP_BLOCK_REASON });
  } else {
    output({});
  }
}

export function hookSessionStart(data: Record<string, unknown>, harness: string): void {
  const parsed = parseHarnessInput(data, harness);
  logHook(`SESSION START for session ${parsed.session_id}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  output({});
}

export function hookPrecompact(data: Record<string, unknown>, harness: string): void {
  const parsed = parseHarnessInput(data, harness);
  logHook(`PRE-COMPACT triggered for session ${parsed.session_id}`);

  // Optional: synchronous auto-ingest (best-effort)
  maybeAutoIngest();

  output({ decision: 'block', reason: PRECOMPACT_BLOCK_REASON });
}

/**
 * Read stdin JSON, dispatch to hook handler.
 */
export async function runHook(hookName: HookName, harness: Harness): Promise<void> {
  let data: Record<string, unknown> = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdin = Buffer.concat(chunks).toString('utf-8');
    if (stdin.trim()) data = JSON.parse(stdin);
  } catch {
    logHook('WARNING: Failed to parse stdin JSON, proceeding with empty data');
  }

  const hooks: Record<HookName, (d: Record<string, unknown>, h: string) => void> = {
    'session-start': hookSessionStart,
    stop: hookStop,
    precompact: hookPrecompact,
  };

  const handler = hooks[hookName];
  if (!handler) {
    process.stderr.write(`Unknown hook: ${hookName}\n`);
    process.exit(1);
  }
  handler(data, harness);
}
