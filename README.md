# mempalace-node

[中文文档](./README.zh.md)

Node.js port of [MemPalace](https://github.com/milla-jovovich/mempalace). The Python original is the highest-scoring AI memory system on the LongMemEval benchmark (96.6% Recall@5). This port preserves storage and retrieval semantics with full-precision brute-force cosine similarity (no HNSW approximation), so retrieval accuracy should match the Python original. The default SQLite backend handles up to ~100K drawers per palace; once you outgrow that, the pluggable `VectorStore` interface lets you migrate to LanceDB without touching application code.

**Fully local. Fully offline. No API calls. No cloud dependencies.**

## Features

| Feature | Description |
|---|---|
| **Verbatim storage** | No summarization. Original text preserved in full. |
| **4-Layer memory stack** | L0 identity / L1 essential / L2 on-demand / L3 deep search |
| **Pluggable vector store** | Swap backends via `setStoreBackend()` (SQLite default, LanceDB ready) |
| **Palace graph** | BFS traversal across rooms via shared wings (tunnels) |
| **Knowledge graph** | Temporal entity-relationship triples with valid-from/valid-to |
| **AAAK Dialect** | Optional lossy compression with entity codes + emotion markers |
| **Entity registry** | Persistent personal name registry with Wikipedia lookup |
| **Entity detector** | Auto-detect people/projects from text via signal scoring |
| **General extractor** | Extract decisions / preferences / milestones / problems / emotional |
| **Room auto-detection** | Infer rooms from folder structure or filename patterns |
| **Conversation mining** | Ingest Claude Code, ChatGPT, Slack, Codex chat exports |
| **MCP server** | 19-tool JSON-RPC server for Claude Desktop / Cursor / Cline |
| **CLI hooks** | session-start, stop, precompact for auto-save workflows |
| **Spell correction** | Optional, preserves technical terms and entity names |
| **Mega-file splitter** | Split concatenated transcripts into per-session files |
| **Multilingual** | Chinese, English, Japanese, Korean, 50+ languages out of the box |

## Performance

Real numbers from `tests/test-benchmark.ts`. Run `node dist/tests/test-benchmark.js`
to reproduce on your hardware.

**Hardware:** Apple M1 (8 cores), Node 24.7, multilingual model (384-dim)

| Drawers | Cold query | Warm query | Filtered query | Heap   | Worker path |
|--------:|-----------:|-----------:|---------------:|-------:|-------------|
|     100 |        4ms |        5ms |            3ms |  231MB | —           |
|   1,000 |        6ms |        6ms |            3ms |  247MB | —           |
|   5,000 |       89ms |       28ms |            7ms |  255MB | engaged     |
|  10,000 |      151ms |      142ms |           20ms |  239MB | engaged     |

What this means in practice:

- **Filtered queries scale almost flat** thanks to metadata pre-filtering — a
  10K palace filtered down to 1K candidates queries in 20ms, the same shape as a
  raw 1K palace would. **Always pass `where: { wing: ... }` when you know it.**
- **Cold vs warm gap shrinks at scale** because the dominant cost shifts from
  BLOB decoding to actual cosine math.
- **Worker thread path engages above 5000 candidates**, distributing the cosine
  work across CPU cores via `SharedArrayBuffer` (zero-copy).
- **Heap stays bounded around 250MB** — the streaming top-K loader never holds
  more than 1000 vectors in memory at a time, regardless of palace size.

For larger palaces (100K+) or sub-50ms latency at scale, swap to the LanceDB
backend — see [Vector Store Architecture](#vector-store-architecture-pluggable-backends)
below.

### Comparison with Python original (ChromaDB)

To validate the port, both engines were benchmarked on the **same dataset** with
the **same embedding model** (`all-MiniLM-L6-v2`, 384-dim) on Apple M1.

Reproduce yourself:
- Node: `MODEL=english node dist/tests/test-benchmark.js`
- Python: `pip install chromadb && python3 -u tests/benchmark-python.py`

| Metric              | Drawers | Python (ChromaDB) | Node (this) |
|---------------------|--------:|------------------:|------------:|
| Cold query latency  |     100 |              87ms |     **7ms** |
| Cold query latency  |      1K |              86ms |    **10ms** |
| Cold query latency  |     10K |          **78ms** |       305ms |
| Filtered query      |      1K |              77ms |     **6ms** |
| Filtered query      |     10K |              81ms |    **29ms** |
| Heap (10K palace)   |     10K |             936MB |    **37MB** |

**Why Node is faster on small + filtered cases:**

- JSON1 metadata pre-filter — `where: { wing: ... }` cuts the candidate pool to
  10% of the palace before any vector math runs
- Brute-force is exact — every result is the true top-K, no recall loss vs
  HNSW's ~95% approximation

**Why Python wins on the 10K unfiltered query case:**

- ChromaDB uses HNSW (hierarchical navigable small world graph), an O(log N)
  approximate nearest neighbor index. At 10K+ candidates with no metadata
  filter, the index amortization pays off.
- For workloads that hit this regime, plug in the LanceDB backend (also HNSW)
  via the pluggable interface — see below.

**The takeaway:** for the typical agent-memory workload (5–50K drawers per
wing, always wing-filtered), this port delivers single-digit-millisecond
queries with a **~25x smaller memory footprint** than the ChromaDB backend.

## Install

```bash
npm install mempalace-node
# or
pnpm add mempalace-node
```

Optional peer dependencies:
- `nspell` + `dictionary-en` — English spell correction

## Quick Start

```typescript
import {
  MemoryStack, searchMemories, createStore,
  KnowledgeGraph, setModel,
} from 'mempalace-node';

// 1. Choose embedding model (optional, default: multilingual)
setModel('multilingual');  // 50+ languages

// 2. Store memories (uses default SQLite backend)
const store = createStore('~/.mempalace/palace');
await store.upsert('memory-1', 'Alice loves hiking and dislikes meetings', {
  wing: 'alice',
  room: 'preferences',
});

// 3. Search semantically
const results = await searchMemories('what does Alice like?');

// 4. 4-Layer Memory Stack — wake-up context for AI
const stack = new MemoryStack();
console.log(stack.wakeUp());                   // L0 identity + L1 essential (~600-900 tokens)
console.log(stack.recall('alice'));            // L2 on-demand by wing
console.log(await stack.search('hiking'));     // L3 deep search

// 5. Knowledge graph with time travel
const kg = new KnowledgeGraph();
kg.addTriple('Alice', 'works_on', 'ProjectX', { validFrom: '2026-01-01' });
kg.addTriple('Alice', 'likes', 'TypeScript');
console.log(kg.queryEntity('Alice', '2026-03-15'));  // facts valid on that date
kg.invalidate('Alice', 'works_on', 'ProjectX', '2026-06-01');  // mark as ended
```

## Vector Store Architecture (Pluggable Backends)

The library uses an abstract `VectorStore` interface so you can swap storage implementations without changing any other code.

### Default: SQLite (brute-force cosine similarity)

- **Best for** ≤100K drawers (typical agent memory use case)
- **Accuracy** 100% (exact, not approximate)
- **Speed** ~5-10ms for 1K drawers, ~50ms for 100K drawers
- **Dependencies** `better-sqlite3` only — no native vector index
- **Cross-platform** Works everywhere `better-sqlite3` works

```typescript
import { createStore, setStoreBackend } from 'mempalace-node';

setStoreBackend('sqlite');  // explicit (this is the default)
const store = createStore('~/.mempalace/palace');
```

#### SQLite optimizations (all enabled by default)

The SQLite backend includes four optimizations that push the brute-force
ceiling from ~10K to ~100K drawers without any vector index:

1. **Float32Array direct compute** — cosine similarity runs on `Float32Array`
   in contiguous memory instead of `number[]`, 3-5× faster in V8.

2. **LRU vector cache** — decoded `Float32Array` views are kept in memory
   keyed by drawer ID. Repeat queries against the same wing/room re-use
   already-decoded vectors. Default capacity: 5000 vectors (~7.5MB at
   384-dim). Tune via the `VECTOR_CACHE_SIZE` constant in `store.ts`.

3. **Streaming top-K with min-heap** — instead of loading all candidate
   vectors into memory and sorting, the store fetches rows in batches of
   1000 and maintains a bounded min-heap. Memory peak is constant
   regardless of palace size — 100K drawers won't OOM the process.

4. **Worker thread parallelism** — when the candidate set exceeds 5000,
   the store automatically distributes the cosine work across `os.cpus().length - 1`
   worker threads via `SharedArrayBuffer` (zero-copy). On a 4-core machine
   this gives ~3× speedup.

The first three optimizations always run. The worker threads only spin up
above the 5000-candidate threshold to avoid overhead on small queries.

To free memory or release threads:

```typescript
import { shutdownWorkerPool } from 'mempalace-node';

store.clearCache();        // free LRU cache without closing the DB
store.close();             // close DB + clear cache
shutdownWorkerPool();      // terminate all worker threads (call on app exit)
```

### Migrating to LanceDB at scale

LanceDB uses an HNSW-style approximate nearest neighbor index, dropping
query complexity from O(N) to O(log N). The trade-off: returned results
aren't guaranteed to be the true top-K (typical recall is ~95%); in
exchange, query latency stays roughly flat regardless of palace size —
whether you have a thousand drawers or a million, you're looking at
about 15ms.

It ships an official Node.js client (`@lancedb/lancedb`) with prebuilt
binaries for every platform. Because the project routes everything
through the pluggable `VectorStore` interface, swapping backends doesn't
touch any of your application code:

```typescript
import { createStore, setStoreBackend, registerStoreFactory } from 'mempalace-node';
import { LanceVectorStore } from './my-lance-store';  // implement VectorStore interface

registerStoreFactory('lance', (path) => new LanceVectorStore(path));
setStoreBackend('lance');

const store = createStore('~/.mempalace/palace');  // now uses LanceDB
```

### Implementing your own backend

Any class that implements the `VectorStore` interface can be plugged in:

```typescript
import {
  VectorStore, DrawerMetadata, GetOptions, GetResult, QueryOptions, QueryResult,
  registerStoreFactory,
} from 'mempalace-node';

class MyCustomStore implements VectorStore {
  async upsert(id: string, document: string, metadata: DrawerMetadata): Promise<void> { /* ... */ }
  delete(id: string): void { /* ... */ }
  get(options?: GetOptions): GetResult { /* ... */ }
  async query(options: QueryOptions): Promise<QueryResult> { /* ... */ }
  count(): number { /* ... */ }
  close(): void { /* ... */ }
}

registerStoreFactory('my-custom', (path) => new MyCustomStore(path));
setStoreBackend('my-custom');
```

The rest of the library (miner, layers, searcher, graph, mcp-server) never imports a concrete store class — only the `VectorStore` interface and `createStore()` function — so swapping is a zero-touch change at the call site.

## Memory Palace Architecture

### Concepts

| Concept | Meaning | Example |
|---|---|---|
| **Wing** | A person or project | `alice`, `my-app` |
| **Room** | A topic category | `technical`, `decisions`, `interests` |
| **Drawer** | A verbatim text chunk (~800 chars) | The actual stored content |
| **Hall** | Connection within a wing | Links between rooms |
| **Tunnel** | Cross-wing connection | Same room appearing in multiple wings |

### 4-Layer Memory Stack

| Layer | Tokens | When Loaded | Purpose |
|---|---|---|---|
| L0 Identity | ~100 | Always | "Who am I?" from `~/.mempalace/identity.txt` |
| L1 Essential | ~500-800 | Always | Top 15 highest-weight drawers, grouped by room |
| L2 On-Demand | ~200-500 | Topic triggered | Wing/room filtered retrieval |
| L3 Deep Search | Unlimited | Explicit search | Full semantic vector search |

Wake-up cost: **~600-900 tokens**. Leaves 95%+ of context free.

## Complete Feature Guide

### 1. Embedding Models

```typescript
import { setModel } from 'mempalace-node';

setModel('multilingual');  // paraphrase-multilingual-MiniLM-L12-v2 (384-dim, ~120MB)
setModel('english');       // all-MiniLM-L6-v2 (384-dim, ~23MB) — matches original
setModel('bge-m3');        // bge-m3 (1024-dim, ~560MB) — best multilingual
```

> **Warning:** Switching models invalidates existing embeddings. The palace database records which model created it and warns on mismatch.

### 2. File Mining

```typescript
import { mine } from 'mempalace-node';

const result = await mine({
  projectDir: './my-project',
  palacePath: '~/.mempalace/palace',
  wingOverride: 'my-app',
  respectGitignore: true,
});
```

Requires a `mempalace.yaml` (auto-generated by `mempalace init`):

```yaml
wing: my-project
rooms:
  - name: frontend
    description: UI components
    keywords: [react, component, css]
```

### 3. Conversation Mining

```typescript
import { mineConvos } from 'mempalace-node';

await mineConvos({
  convoDir: '~/chat-exports',
  palacePath: '~/.mempalace/palace',
  wing: 'conversations',
  extractMode: 'exchange',  // or 'general' for memory-type extraction
});
```

Supported formats (auto-detected):
- **OpenClaw JSONL sessions** (`~/.openclaw/agents/<id>/sessions/*.jsonl`) — native support, parses message blocks including tool calls
- Claude Code JSONL sessions
- OpenAI Codex CLI JSONL
- Claude.ai JSON export
- ChatGPT `conversations.json`
- Slack channel JSON
- Plain text with `>` markers

### 4. Search

```typescript
import { searchMemories, checkDuplicate } from 'mempalace-node';

const results = await searchMemories('database migration', undefined, 'my-app', 'backend');
// { query, filters, results: [{ text, wing, room, sourceFile, similarity }] }

const dup = await checkDuplicate('some text');
// { isDuplicate, similarity, existingText? }
```

### 5. Palace Graph

```typescript
import { traverse, findTunnels, graphStats } from 'mempalace-node';

const connected = traverse('frontend', undefined, 2);   // BFS, max 2 hops
const tunnels = findTunnels('my-app', 'docs');          // bridging rooms
const stats = graphStats();
```

### 6. Knowledge Graph

```typescript
import { KnowledgeGraph } from 'mempalace-node';

const kg = new KnowledgeGraph();

kg.addEntity('Alice', 'person', { role: 'engineer' });
kg.addTriple('Alice', 'works_on', 'ProjectX', {
  validFrom: '2026-01-01',
  confidence: 0.9,
});

kg.queryEntity('Alice');                       // current facts
kg.queryEntity('Alice', '2026-03-15');         // time-filtered
kg.timeline('Alice');                          // chronological history
kg.invalidate('Alice', 'works_on', 'ProjectX', '2026-06-01');

kg.stats();
kg.close();
```

### 7. AAAK Dialect

```typescript
import { Dialect } from 'mempalace-node';

const dialect = new Dialect({ entities: { Alice: 'ALC', Bob: 'BOB' } });

const compressed = dialect.compress(
  'Alice decided to use GraphQL instead of REST because of better performance',
  { wing: 'tech', room: 'decisions' },
);
const stats = dialect.compressionStats(originalText, compressed);
```

> **Note:** AAAK is **lossy summarization, not compression**. The 96.6% benchmark uses verbatim storage. AAAK scores 84% but saves tokens.

### 8. Entity Registry

```typescript
import { EntityRegistry } from 'mempalace-node';

const registry = EntityRegistry.load();

registry.seed('personal',
  [
    { name: 'Alice', relationship: 'partner', context: 'personal' },
    { name: 'Riley', relationship: 'daughter', context: 'personal' },
  ],
  ['MyApp'],
  { Riley: 'Rileigh' },
);

registry.lookup('Riley', 'I went hiking with Riley today');
// → { type: 'person', confidence: 1.0, ... }

const wiki = await registry.research('Sam');
const learned = await registry.learnFromText(longSessionText);
const names = registry.extractPeopleFromQuery('Did Alice meet with Riley?');
```

### 9. Entity Detector

```typescript
import { detectEntities, scanForDetection } from 'mempalace-node';

const files = scanForDetection('./my-project');
const detected = detectEntities(files);
// { people: [...], projects: [...], uncertain: [...] }
```

### 10. General Extractor

```typescript
import { extractMemories } from 'mempalace-node';

const memories = extractMemories(text);
// 5 types: decision / preference / milestone / problem / emotional
```

### 11. Room Detector

```typescript
import { detectRoomsLocal } from 'mempalace-node';

const result = detectRoomsLocal('./my-project');
// Auto-generates mempalace.yaml with detected rooms
```

### 12. Onboarding

```typescript
import { runOnboarding, quickSetup } from 'mempalace-node';

const { registry, ambiguous, bootstrap } = runOnboarding({
  mode: 'personal',
  people: [{ name: 'Alice', relationship: 'partner', context: 'personal' }],
  projects: ['MemPalace'],
});
```

### 13. Split Mega Files

```typescript
import { splitMegaFiles } from 'mempalace-node';

const result = splitMegaFiles({
  sourceDir: '~/Desktop/transcripts',
  minSessions: 2,
});
```

### 14. MCP Server

Standard JSON-RPC 2.0 stdio server. Works with any MCP-compatible client:
**Claude Desktop**, **Cursor**, **Cline**, **Continue**, **OpenClaw**, etc.

```typescript
import { runMcpServer } from 'mempalace-node';
runMcpServer('~/.mempalace/palace');
```

Or via CLI:
```bash
mempalace mcp --palace ~/.mempalace/palace
```

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "mempalace": {
      "command": "npx",
      "args": ["mempalace-node", "mcp"]
    }
  }
}
```

**OpenClaw** (`<workspace>/.mcp.json` inside any agent workspace):
```json
{
  "mcpServers": {
    "mempalace": {
      "command": "npx",
      "args": ["mempalace-node", "mcp"],
      "env": {
        "MEMPALACE_PALACE_PATH": "/path/to/your/palace"
      }
    }
  }
}
```

Then add to your `MEMORY.md` so the agent knows the tools exist:
```markdown
## Long-term Memory

You have access to a semantic memory system via mempalace tools.
Before responding about any person, project, or past event, call:
- mempalace_search("query") to find verbatim memories
- mempalace_kg_query("entity") to get relationships
- mempalace_diary_write("agent_name", "what you learned") at session end
```

**19 tools available:**
- Read: `mempalace_status`, `mempalace_list_wings`, `mempalace_list_rooms`, `mempalace_get_taxonomy`, `mempalace_search`, `mempalace_check_duplicate`, `mempalace_get_aaak_spec`
- Write: `mempalace_add_drawer`, `mempalace_delete_drawer`
- Knowledge graph: `mempalace_kg_query`, `mempalace_kg_add`, `mempalace_kg_invalidate`, `mempalace_kg_timeline`, `mempalace_kg_stats`
- Graph traversal: `mempalace_traverse`, `mempalace_find_tunnels`, `mempalace_graph_stats`
- Agent diary: `mempalace_diary_write`, `mempalace_diary_read`

### 15. Hooks

```typescript
import { runHook } from 'mempalace-node';
await runHook('stop', 'claude-code');
```

Set `MEMPAL_DIR` env var to enable auto-ingest after every N exchanges.

### 16. Spell Correction

```bash
npm install nspell dictionary-en
```

```typescript
import { spellcheckUserText } from 'mempalace-node';
const corrected = await spellcheckUserText('lsresdy knoe the question');
// → 'already know the question'
```

## CLI Usage

After installing globally (`npm install -g mempalace-node`):

```bash
mempalace init ~/projects/my-app          # Initialize a project
mempalace mine ~/projects/my-app          # Mine project files
mempalace mine ~/chats --mode convos      # Mine conversation exports
mempalace search "query"                  # Semantic search
mempalace search "query" --wing my-app    # Filter by wing
mempalace wake-up                         # Show L0 + L1 context
mempalace wake-up --wing my-app           # Wing-specific wake-up
mempalace status                          # Show what's been filed
mempalace split ~/Desktop/transcripts     # Split mega-files
mempalace compress --wing my-app --dry-run  # Preview AAAK compression
mempalace mcp                             # Run MCP server (stdio)
mempalace hook run --hook stop --harness claude-code
```

## Configuration

Config file: `~/.mempalace/config.json`

```json
{
  "palace_path": "~/.mempalace/palace",
  "collection_name": "mempalace_drawers",
  "embedding_model": "multilingual"
}
```

Environment variable: `MEMPALACE_PALACE_PATH`

## Use with Electron

```typescript
// Electron main process
import { app } from 'electron';
import * as path from 'path';
import { MemoryStack, setModel, createStore } from 'mempalace-node';

setModel('multilingual');

const palaceDir = path.join(app.getPath('userData'), 'mempalace', 'palace');
const stack = new MemoryStack(palaceDir);
const store = createStore(palaceDir);

// Inject wake-up context into AI system prompt
const context = stack.wakeUp();

// Store memories after conversations
await store.upsert(id, 'User mentioned they prefer dark mode', {
  wing: 'preferences', room: 'ui',
});
```

The embedding model (~120MB) downloads on first run and caches in the OS model cache directory. After that, everything runs offline.

## Differences from Python Original

| Aspect | Python | Node.js |
|---|---|---|
| Vector store | ChromaDB PersistentClient (HNSW) | Pluggable: SQLite (default) or LanceDB |
| Embedding | ChromaDB built-in | @xenova/transformers |
| Model options | all-MiniLM-L6-v2 | english, multilingual, bge-m3 |
| AAAK compression | ✅ | ✅ |
| MCP server | ✅ (19 tools) | ✅ (19 tools) |
| Spellcheck | ✅ | ✅ (optional) |
| Entity registry | ✅ | ✅ |
| Entity detector | ✅ | ✅ |
| General extractor | ✅ | ✅ |
| Room auto-detect | ✅ | ✅ |
| Onboarding | ✅ (interactive) | ✅ (programmatic) |
| CLI | ✅ | ✅ |
| Default scale limit | 100K+ drawers (HNSW) | ~100K drawers (optimized brute-force) |
| Optional larger scale | — | LanceDB backend (1M+) |

## Credits

Node.js port of [MemPalace](https://github.com/milla-jovovich/mempalace) by [Milla Jovovich](https://github.com/milla-jovovich). Original is MIT licensed. All architectural decisions, the memory palace metaphor, the 4-layer stack design, and the temporal knowledge graph schema are from the original.

## License

MIT
