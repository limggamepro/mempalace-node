#!/usr/bin/env node
/**
 * cli.ts — MemPalace command-line entry point.
 *
 * Direct port of mempalace/cli.py.
 *
 * Usage:
 *   mempalace init <dir>                  Initialize a project
 *   mempalace mine <dir>                  Mine project files
 *   mempalace mine <dir> --mode convos    Mine conversation exports
 *   mempalace search "query"              Find anything
 *   mempalace wake-up                     Show L0 + L1 context
 *   mempalace status                      Show what's been filed
 *   mempalace split <dir>                 Split mega-files
 *   mempalace compress                    Compress drawers via AAAK
 *   mempalace mcp                         Run MCP server
 *   mempalace hook <hook> <harness>       Run hook
 *   mempalace instructions <name>         Show instructions
 */

import * as os from 'os';
import * as path from 'path';
import { MempalaceConfig } from './config';
import { mine, status as minerStatus } from './miner';
import { mineConvos } from './convo-miner';
import { searchMemories } from './searcher';
import { MemoryStack } from './layers';
import { detectRoomsLocal } from './room-detector';
import { detectEntities, scanForDetection } from './entity-detector';
import { splitMegaFiles } from './split-mega-files';
import { Dialect } from './dialect';
import { createStore } from './vector-store';
import type { VectorStore } from './vector-store';
import { runMcpServer } from './mcp-server';
import { runHook, HookName, Harness } from './hooks-cli';
import { runInstructions } from './instructions-cli';
import * as fs from 'fs';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] || '';
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        // Append to array if multi-flag
        if (key === 'include-ignored') {
          if (!Array.isArray(flags[key])) flags[key] = [];
          (flags[key] as string[]).push(next);
        } else {
          flags[key] = next;
        }
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function getPalacePath(flags: Record<string, unknown>): string {
  if (typeof flags.palace === 'string') {
    return flags.palace.startsWith('~') ? path.join(os.homedir(), flags.palace.slice(1)) : flags.palace;
  }
  return new MempalaceConfig().palacePath;
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdInit(args: ParsedArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) {
    process.stderr.write('Usage: mempalace init <dir>\n');
    process.exit(1);
  }

  // Pass 1: detect entities
  process.stdout.write(`\n  Scanning for entities in: ${dir}\n`);
  const files = scanForDetection(dir);
  if (files.length > 0) {
    process.stdout.write(`  Reading ${files.length} files...\n`);
    const detected = detectEntities(files);
    const total = detected.people.length + detected.projects.length + detected.uncertain.length;
    if (total > 0) {
      const entitiesPath = path.join(path.resolve(dir), 'entities.json');
      fs.writeFileSync(entitiesPath, JSON.stringify({
        people: detected.people.map(p => p.name),
        projects: detected.projects.map(p => p.name),
      }, null, 2));
      process.stdout.write(`  Entities saved: ${entitiesPath}\n`);
    }
  }

  // Pass 2: detect rooms from folder structure
  const result = detectRoomsLocal(dir);
  process.stdout.write(`\n  Wing: ${result.projectName}\n`);
  process.stdout.write(`  Rooms (${result.source}): ${result.rooms.map(r => r.name).join(', ')}\n`);
  process.stdout.write(`  Config saved: ${result.configPath}\n`);

  new MempalaceConfig().init();
}

async function cmdMine(args: ParsedArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) {
    process.stderr.write('Usage: mempalace mine <dir>\n');
    process.exit(1);
  }
  const palacePath = getPalacePath(args.flags);
  const mode = (args.flags.mode as string) || 'projects';
  const wing = args.flags.wing as string | undefined;
  const agent = (args.flags.agent as string) || 'mempalace';
  const limit = args.flags.limit ? parseInt(String(args.flags.limit), 10) : 0;
  const dryRun = args.flags['dry-run'] === true;

  if (mode === 'convos') {
    const extract = ((args.flags.extract as string) || 'exchange') as 'exchange' | 'general';
    const result = await mineConvos({
      convoDir: dir, palacePath, wing, agent, limit, dryRun, extractMode: extract,
    });
    process.stdout.write(`\nDone. ${result.totalDrawers} drawers from ${result.filesProcessed} files (${result.filesSkipped} skipped)\n`);
  } else {
    const includeIgnored = (args.flags['include-ignored'] as string[] | undefined) || [];
    const result = await mine({
      projectDir: dir, palacePath,
      wingOverride: wing, agent, limit, dryRun,
      respectGitignore: args.flags['no-gitignore'] !== true,
      includeIgnored,
    });
    process.stdout.write(`\nDone. ${result.totalDrawers} drawers from ${result.filesProcessed} files\n`);
    if (Object.keys(result.roomCounts).length > 0) {
      process.stdout.write('By room:\n');
      for (const [room, count] of Object.entries(result.roomCounts)) {
        process.stdout.write(`  ${room.padEnd(20)} ${count} files\n`);
      }
    }
  }
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query) {
    process.stderr.write('Usage: mempalace search "query"\n');
    process.exit(1);
  }
  const palacePath = getPalacePath(args.flags);
  const wing = args.flags.wing as string | undefined;
  const room = args.flags.room as string | undefined;
  const nResults = args.flags.results ? parseInt(String(args.flags.results), 10) : 5;

  const result = await searchMemories(query, palacePath, wing, room, nResults);
  if ('error' in result) {
    process.stderr.write(`${result.error}\n${result.hint || ''}\n`);
    process.exit(1);
  }

  process.stdout.write(`\n${'='.repeat(60)}\n  Results for: "${query}"\n${'='.repeat(60)}\n\n`);
  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    process.stdout.write(`  [${i + 1}] ${r.wing} / ${r.room}\n`);
    process.stdout.write(`      Source: ${r.sourceFile}\n`);
    process.stdout.write(`      Match:  ${r.similarity}\n\n`);
    for (const line of r.text.trim().split('\n')) {
      process.stdout.write(`      ${line}\n`);
    }
    process.stdout.write(`\n  ${'─'.repeat(56)}\n`);
  }
  process.stdout.write('\n');
}

async function cmdWakeup(args: ParsedArgs): Promise<void> {
  const palacePath = getPalacePath(args.flags);
  const wing = args.flags.wing as string | undefined;
  const stack = new MemoryStack(palacePath);
  const text = stack.wakeUp(wing);
  const tokens = Math.floor(text.length / 4);
  process.stdout.write(`Wake-up text (~${tokens} tokens):\n${'='.repeat(50)}\n${text}\n`);
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const palacePath = getPalacePath(args.flags);
  const result = minerStatus(palacePath);
  process.stdout.write(`\n${'='.repeat(55)}\n  MemPalace Status — ${result.totalDrawers} drawers\n${'='.repeat(55)}\n\n`);
  for (const [wing, rooms] of Object.entries(result.wingRooms)) {
    process.stdout.write(`  WING: ${wing}\n`);
    const sorted = Object.entries(rooms).sort((a, b) => b[1] - a[1]);
    for (const [room, count] of sorted) {
      process.stdout.write(`    ROOM: ${room.padEnd(20)} ${String(count).padStart(5)} drawers\n`);
    }
    process.stdout.write('\n');
  }
}

async function cmdSplit(args: ParsedArgs): Promise<void> {
  const dir = args.positional[0];
  if (!dir) {
    process.stderr.write('Usage: mempalace split <dir>\n');
    process.exit(1);
  }
  const result = splitMegaFiles({
    sourceDir: dir,
    outputDir: args.flags['output-dir'] as string | undefined,
    minSessions: args.flags['min-sessions'] ? parseInt(String(args.flags['min-sessions']), 10) : 2,
    dryRun: args.flags['dry-run'] === true,
  });
  process.stdout.write(`\nDone. ${result.totalWritten} files created.\n`);
}

async function cmdCompress(args: ParsedArgs): Promise<void> {
  const palacePath = getPalacePath(args.flags);
  const wing = args.flags.wing as string | undefined;
  const dryRun = args.flags['dry-run'] === true;
  const configPath = args.flags.config as string | undefined;

  let dialect: Dialect;
  if (configPath && fs.existsSync(configPath)) {
    dialect = Dialect.fromConfig(configPath);
    process.stdout.write(`  Loaded entity config: ${configPath}\n`);
  } else {
    dialect = new Dialect();
  }

  let store: VectorStore;
  try {
    store = createStore(palacePath);
  } catch {
    process.stderr.write(`\n  No palace found at ${palacePath}\n`);
    process.exit(1);
  }

  const where = wing ? { wing } : undefined;
  const all = store.get({ where, limit: 100000 });

  if (all.documents.length === 0) {
    process.stdout.write(`\n  No drawers found${wing ? ` in wing '${wing}'` : ''}.\n`);
    return;
  }

  process.stdout.write(`\n  Compressing ${all.documents.length} drawers${wing ? ` in wing '${wing}'` : ''}...\n\n`);

  let totalOriginal = 0;
  let totalCompressed = 0;

  for (let i = 0; i < all.documents.length; i++) {
    const doc = all.documents[i];
    const meta = all.metadatas[i];
    const compressed = dialect.compress(doc, meta);
    const stats = dialect.compressionStats(doc, compressed);
    totalOriginal += stats.original_chars;
    totalCompressed += stats.summary_chars;

    if (dryRun) {
      const wingName = (meta.wing as string) || '?';
      const roomName = (meta.room as string) || '?';
      process.stdout.write(`  [${wingName}/${roomName}] ${stats.original_tokens_est}t -> ${stats.summary_tokens_est}t (${stats.size_ratio}x)\n`);
      process.stdout.write(`    ${compressed}\n\n`);
    }
  }

  const ratio = totalOriginal / Math.max(totalCompressed, 1);
  process.stdout.write(`  Total: ${totalOriginal} -> ${totalCompressed} chars (${ratio.toFixed(1)}x compression)\n`);
  if (dryRun) process.stdout.write('  (dry run -- nothing stored)\n');

  store.close();
}

async function cmdMcp(args: ParsedArgs): Promise<void> {
  const palacePath = args.flags.palace as string | undefined;
  runMcpServer(palacePath);
}

async function cmdHook(args: ParsedArgs): Promise<void> {
  const hook = args.flags.hook as HookName;
  const harness = args.flags.harness as Harness;
  if (!hook || !harness) {
    process.stderr.write('Usage: mempalace hook run --hook <hook> --harness <harness>\n');
    process.exit(1);
  }
  await runHook(hook, harness);
}

async function cmdInstructions(args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) {
    process.stderr.write('Usage: mempalace instructions <name>\n');
    process.exit(1);
  }
  runInstructions(name);
}

// ── Main ────────────────────────────────────────────────────────────────────

const HELP = `MemPalace — Give your AI a memory. No API key required.

Commands:
  mempalace init <dir>                  Detect rooms from folder structure
  mempalace mine <dir>                  Mine project files
  mempalace mine <dir> --mode convos    Mine conversation exports
  mempalace search "query"              Find anything, exact words
  mempalace wake-up                     Show L0 + L1 wake-up context
  mempalace wake-up --wing my_app       Wake-up for a specific project
  mempalace status                      Show what's been filed
  mempalace split <dir>                 Split concatenated mega-files
  mempalace compress                    Compress drawers using AAAK Dialect
  mempalace mcp [--palace PATH]         Run MCP server (stdio)
  mempalace hook run --hook <h> --harness <hr>
  mempalace instructions <name>         Show instructions
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP);
    return;
  }

  const args = parseArgs(argv);
  const dispatch: Record<string, (a: ParsedArgs) => Promise<void>> = {
    init: cmdInit,
    mine: cmdMine,
    search: cmdSearch,
    'wake-up': cmdWakeup,
    wakeup: cmdWakeup,
    status: cmdStatus,
    split: cmdSplit,
    compress: cmdCompress,
    mcp: cmdMcp,
    hook: cmdHook,
    instructions: cmdInstructions,
  };

  const handler = dispatch[args.command];
  if (!handler) {
    process.stderr.write(`Unknown command: ${args.command}\n${HELP}`);
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (e) {
    process.stderr.write(`Error: ${e}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
