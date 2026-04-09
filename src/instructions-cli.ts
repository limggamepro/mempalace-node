/**
 * instructions-cli.ts — Instruction text output for MemPalace commands.
 *
 * Direct port of mempalace/instructions_cli.py.
 *
 * Each instruction lives as a markdown string. Returns the content for
 * the requested instruction name.
 */

const INSTRUCTIONS: Record<string, string> = {
  init: `# mempalace init

Initialize MemPalace for a project directory.

## Usage

    mempalace init <directory>

## What it does

1. Scans your project files for capitalized proper nouns (people, projects)
2. Auto-detects rooms from your folder structure (frontend, backend, docs, etc.)
3. Creates mempalace.yaml in the project directory
4. Creates ~/.mempalace/config.json if it doesn't exist

## Next step

    mempalace mine <directory>
`,

  mine: `# mempalace mine

Mine files into the palace.

## Usage

    mempalace mine <directory>                  # Project files (default)
    mempalace mine <directory> --mode convos    # Conversation exports
    mempalace mine <directory> --wing my_app    # Override wing name
    mempalace mine <directory> --dry-run        # Preview without filing

## Modes

- **projects** (default) — Code, docs, notes. Respects .gitignore.
- **convos** — Chat exports (Claude, ChatGPT, Slack, plain text).

## Idempotent

Re-running mine on the same files skips unchanged ones (mtime check).
`,

  search: `# mempalace search

Find anything in the palace using semantic search.

## Usage

    mempalace search "query"                    # Search everything
    mempalace search "query" --wing my_app      # Limit to one wing
    mempalace search "query" --room costs       # Limit to one room
    mempalace search "query" --results 10       # More results

## Returns

Verbatim drawer content with similarity scores. Never summaries.
`,

  status: `# mempalace status

Show what's been filed in the palace.

## Usage

    mempalace status

## Output

- Total drawer count
- Per-wing breakdown
- Per-room breakdown
`,

  help: `# MemPalace Help

Give your AI a memory. No API key required.

## Commands

    mempalace init <dir>             Set up a project
    mempalace mine <dir>             File into the palace
    mempalace search "query"         Find anything
    mempalace wake-up                Show L0+L1 context
    mempalace status                 Show what's filed

## Workflow

1. \`mempalace init ~/my-project\`
2. \`mempalace mine ~/my-project\`
3. \`mempalace search "what we decided about auth"\`
`,
};

export const AVAILABLE_INSTRUCTIONS = ['init', 'search', 'mine', 'help', 'status'];

/**
 * Get instruction text by name.
 */
export function getInstructions(name: string): string {
  if (!(name in INSTRUCTIONS)) {
    throw new Error(`Unknown instructions: ${name}. Available: ${AVAILABLE_INSTRUCTIONS.join(', ')}`);
  }
  return INSTRUCTIONS[name];
}

/**
 * Print instructions to stdout. CLI entry point.
 */
export function runInstructions(name: string): void {
  try {
    process.stdout.write(getInstructions(name));
  } catch (e) {
    process.stderr.write(`${e}\n`);
    process.exit(1);
  }
}
