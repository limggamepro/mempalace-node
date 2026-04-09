/**
 * mcp-server.ts — MemPalace MCP Server (Model Context Protocol)
 *
 * Direct port of mempalace/mcp_server.py.
 *
 * Provides 19 tools over JSON-RPC 2.0 stdio protocol for use with
 * Claude Desktop, Cursor, ChatGPT, etc.
 *
 * Install (Claude Desktop):
 *   claude mcp add mempalace -- npx mempalace-node mcp [--palace /path/to/palace]
 *
 * Tools (read):
 *   mempalace_status, mempalace_list_wings, mempalace_list_rooms,
 *   mempalace_get_taxonomy, mempalace_search, mempalace_check_duplicate,
 *   mempalace_get_aaak_spec, mempalace_traverse, mempalace_find_tunnels,
 *   mempalace_graph_stats
 *
 * Tools (knowledge graph):
 *   mempalace_kg_query, mempalace_kg_add, mempalace_kg_invalidate,
 *   mempalace_kg_timeline, mempalace_kg_stats
 *
 * Tools (diary):
 *   mempalace_diary_write, mempalace_diary_read
 *
 * Tools (write):
 *   mempalace_add_drawer, mempalace_delete_drawer
 */

import * as readline from 'readline';
import * as crypto from 'crypto';
import * as path from 'path';
import { MempalaceConfig } from './config';
import { createStore } from './vector-store';
import type { VectorStore, DrawerMetadata } from './vector-store';
import { searchMemories, checkDuplicate } from './searcher';
import { traverse, findTunnels, graphStats } from './graph';
import { KnowledgeGraph } from './knowledge';

const VERSION = '1.0.0';

// ── AAAK Spec & Protocol (included in status response) ──────────────────────

const PALACE_PROTOCOL = `IMPORTANT — MemPalace Memory Protocol:
1. ON WAKE-UP: Call mempalace_status to load palace overview + AAAK spec.
2. BEFORE RESPONDING about any person, project, or past event: call mempalace_kg_query or mempalace_search FIRST. Never guess — verify.
3. IF UNSURE about a fact (name, gender, age, relationship): say "let me check" and query the palace. Wrong is worse than slow.
4. AFTER EACH SESSION: call mempalace_diary_write to record what happened, what you learned, what matters.
5. WHEN FACTS CHANGE: call mempalace_kg_invalidate on the old fact, mempalace_kg_add for the new one.

This protocol ensures the AI KNOWS before it speaks. Storage is not memory — but storage + this protocol = memory.`;

const AAAK_SPEC = `AAAK is a compressed memory dialect that MemPalace uses for efficient storage.
It is designed to be readable by both humans and LLMs without decoding.

FORMAT:
  ENTITIES: 3-letter uppercase codes. ALC=Alice, JOR=Jordan, RIL=Riley, MAX=Max, BEN=Ben.
  EMOTIONS: *action markers* before/during text. *warm*=joy, *fierce*=determined, *raw*=vulnerable, *bloom*=tenderness.
  STRUCTURE: Pipe-separated fields. FAM: family | PROJ: projects | ⚠: warnings/reminders.
  DATES: ISO format (2026-03-31). COUNTS: Nx = N mentions (e.g., 570x).
  IMPORTANCE: ★ to ★★★★★ (1-5 scale).
  HALLS: hall_facts, hall_events, hall_discoveries, hall_preferences, hall_advice.
  WINGS: wing_user, wing_agent, wing_team, wing_code, wing_myproject, wing_hardware, wing_ue5, wing_ai_research.
  ROOMS: Hyphenated slugs representing named ideas (e.g., chromadb-setup, gpu-pricing).

EXAMPLE:
  FAM: ALC→♡JOR | 2D(kids): RIL(18,sports) MAX(11,chess+swimming) | BEN(contributor)

Read AAAK naturally — expand codes mentally, treat *markers* as emotional context.
When WRITING AAAK: use entity codes, mark emotions, keep structure tight.`;

// ── Tool definitions ────────────────────────────────────────────────────────

interface ToolDef {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface MCPRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Server state ────────────────────────────────────────────────────────────

class McpServer {
  private config: MempalaceConfig;
  private store: VectorStore | null = null;
  private kg: KnowledgeGraph;

  constructor(palacePath?: string) {
    if (palacePath) process.env.MEMPALACE_PALACE_PATH = path.resolve(palacePath);
    this.config = new MempalaceConfig();
    this.kg = new KnowledgeGraph(path.join(this.config.palacePath, 'knowledge_graph.sqlite3'));
  }

  private getStore(): VectorStore | null {
    if (!this.store) {
      try {
        this.store = createStore(this.config.palacePath);
      } catch {
        return null;
      }
    }
    return this.store;
  }

  private noPalace() {
    return { error: 'No palace found', hint: 'Run: mempalace init <dir> && mempalace mine <dir>' };
  }

  // ── READ TOOLS ────────────────────────────────────────────────────────

  toolStatus() {
    const store = this.getStore();
    if (!store) return this.noPalace();

    const count = store.count();
    const wings: Record<string, number> = {};
    const rooms: Record<string, number> = {};

    try {
      const all = store.get({ limit: 10000 });
      for (const m of all.metadatas) {
        const w = (m.wing as string) || 'unknown';
        const r = (m.room as string) || 'unknown';
        wings[w] = (wings[w] || 0) + 1;
        rooms[r] = (rooms[r] || 0) + 1;
      }
    } catch { /* ignore */ }

    return {
      total_drawers: count,
      wings,
      rooms,
      palace_path: this.config.palacePath,
      protocol: PALACE_PROTOCOL,
      aaak_dialect: AAAK_SPEC,
    };
  }

  toolListWings() {
    const store = this.getStore();
    if (!store) return this.noPalace();
    const wings: Record<string, number> = {};
    const all = store.get({ limit: 10000 });
    for (const m of all.metadatas) {
      const w = (m.wing as string) || 'unknown';
      wings[w] = (wings[w] || 0) + 1;
    }
    return { wings };
  }

  toolListRooms(args: { wing?: string }) {
    const store = this.getStore();
    if (!store) return this.noPalace();
    const rooms: Record<string, number> = {};
    const all = store.get({
      where: args.wing ? { wing: args.wing } : undefined,
      limit: 10000,
    });
    for (const m of all.metadatas) {
      const r = (m.room as string) || 'unknown';
      rooms[r] = (rooms[r] || 0) + 1;
    }
    return { wing: args.wing || 'all', rooms };
  }

  toolGetTaxonomy() {
    const store = this.getStore();
    if (!store) return this.noPalace();
    const taxonomy: Record<string, Record<string, number>> = {};
    const all = store.get({ limit: 10000 });
    for (const m of all.metadatas) {
      const w = (m.wing as string) || 'unknown';
      const r = (m.room as string) || 'unknown';
      if (!taxonomy[w]) taxonomy[w] = {};
      taxonomy[w][r] = (taxonomy[w][r] || 0) + 1;
    }
    return { taxonomy };
  }

  async toolSearch(args: { query: string; limit?: number; wing?: string; room?: string }) {
    return await searchMemories(
      args.query,
      this.config.palacePath,
      args.wing,
      args.room,
      args.limit ?? 5,
    );
  }

  async toolCheckDuplicate(args: { content: string; threshold?: number }) {
    return await checkDuplicate(args.content, this.config.palacePath, args.threshold ?? 0.9);
  }

  toolGetAaakSpec() {
    return { aaak_spec: AAAK_SPEC };
  }

  toolTraverse(args: { start_room: string; max_hops?: number }) {
    return traverse(args.start_room, this.config.palacePath, args.max_hops ?? 2);
  }

  toolFindTunnels(args: { wing_a?: string; wing_b?: string }) {
    return findTunnels(args.wing_a, args.wing_b, this.config.palacePath);
  }

  toolGraphStats() {
    return graphStats(this.config.palacePath);
  }

  // ── WRITE TOOLS ───────────────────────────────────────────────────────

  async toolAddDrawer(args: { wing: string; room: string; content: string; source_file?: string; added_by?: string }) {
    const store = this.getStore();
    if (!store) return this.noPalace();

    const hash = crypto.createHash('md5').update(args.content).digest('hex').slice(0, 16);
    const drawerId = `drawer_${args.wing}_${args.room}_${hash}`;

    // Idempotency check
    const existing = store.get({ where: { source_file: drawerId }, limit: 1 });
    if (existing.ids.length > 0) {
      return { success: true, reason: 'already_exists', drawer_id: drawerId };
    }

    try {
      await store.upsert(drawerId, args.content, {
        wing: args.wing,
        room: args.room,
        source_file: args.source_file || '',
        chunk_index: 0,
        added_by: args.added_by || 'mcp',
        filed_at: new Date().toISOString(),
      });
      return { success: true, drawer_id: drawerId, wing: args.wing, room: args.room };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  toolDeleteDrawer(args: { drawer_id: string }) {
    const store = this.getStore();
    if (!store) return this.noPalace();
    try {
      store.delete(args.drawer_id);
      return { success: true, drawer_id: args.drawer_id };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  // ── KNOWLEDGE GRAPH ───────────────────────────────────────────────────

  toolKgQuery(args: { entity: string; as_of?: string; direction?: 'outgoing' | 'incoming' | 'both' }) {
    const facts = this.kg.queryEntity(args.entity, args.as_of, args.direction || 'both');
    return { entity: args.entity, as_of: args.as_of, facts, count: facts.length };
  }

  toolKgAdd(args: { subject: string; predicate: string; object: string; valid_from?: string; source_closet?: string }) {
    const tripleId = this.kg.addTriple(args.subject, args.predicate, args.object, {
      validFrom: args.valid_from,
      sourceCloset: args.source_closet,
    });
    return { success: true, triple_id: tripleId, fact: `${args.subject} → ${args.predicate} → ${args.object}` };
  }

  toolKgInvalidate(args: { subject: string; predicate: string; object: string; ended?: string }) {
    this.kg.invalidate(args.subject, args.predicate, args.object, args.ended);
    return { success: true, fact: `${args.subject} → ${args.predicate} → ${args.object}`, ended: args.ended || 'today' };
  }

  toolKgTimeline(args: { entity?: string }) {
    const timeline = this.kg.timeline(args.entity);
    return { entity: args.entity || 'all', timeline, count: timeline.length };
  }

  toolKgStats() {
    return this.kg.stats();
  }

  // ── DIARY ─────────────────────────────────────────────────────────────

  async toolDiaryWrite(args: { agent_name: string; entry: string; topic?: string }) {
    const store = this.getStore();
    if (!store) return this.noPalace();

    const wing = `wing_${args.agent_name.toLowerCase().replace(/ /g, '_')}`;
    const room = 'diary';
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
    const hash = crypto.createHash('md5').update(args.entry.slice(0, 50)).digest('hex').slice(0, 8);
    const entryId = `diary_${wing}_${dateStr}_${timeStr}_${hash}`;

    try {
      await store.upsert(entryId, args.entry, {
        wing, room,
        hall: 'hall_diary',
        topic: args.topic || 'general',
        type: 'diary_entry',
        agent: args.agent_name,
        filed_at: now.toISOString(),
        date: now.toISOString().slice(0, 10),
      } as DrawerMetadata);

      return {
        success: true, entry_id: entryId, agent: args.agent_name,
        topic: args.topic || 'general', timestamp: now.toISOString(),
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  toolDiaryRead(args: { agent_name: string; last_n?: number }) {
    const store = this.getStore();
    if (!store) return this.noPalace();

    const wing = `wing_${args.agent_name.toLowerCase().replace(/ /g, '_')}`;
    const lastN = args.last_n ?? 10;

    try {
      const results = store.get({
        where: { $and: [{ wing }, { room: 'diary' }] },
        limit: 10000,
      });

      if (results.ids.length === 0) {
        return { agent: args.agent_name, entries: [], message: 'No diary entries yet.' };
      }

      const entries = results.documents.map((doc, i) => ({
        date: (results.metadatas[i].date as string) || '',
        timestamp: (results.metadatas[i].filed_at as string) || '',
        topic: (results.metadatas[i].topic as string) || '',
        content: doc,
      }));

      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return { agent: args.agent_name, entries: entries.slice(0, lastN), total: results.ids.length, showing: Math.min(lastN, entries.length) };
    } catch (e) {
      return { error: String(e) };
    }
  }

  // ── Tool registry ─────────────────────────────────────────────────────

  getTools(): Record<string, ToolDef> {
    return {
      mempalace_status: {
        description: 'Palace overview — total drawers, wing and room counts, plus AAAK spec',
        inputSchema: { type: 'object', properties: {} },
      },
      mempalace_list_wings: {
        description: 'List all wings with drawer counts',
        inputSchema: { type: 'object', properties: {} },
      },
      mempalace_list_rooms: {
        description: 'List rooms within a wing (or all rooms if no wing given)',
        inputSchema: {
          type: 'object',
          properties: { wing: { type: 'string', description: 'Wing to list rooms for (optional)' } },
        },
      },
      mempalace_get_taxonomy: {
        description: 'Full taxonomy: wing → room → drawer count',
        inputSchema: { type: 'object', properties: {} },
      },
      mempalace_get_aaak_spec: {
        description: 'Get the AAAK dialect specification',
        inputSchema: { type: 'object', properties: {} },
      },
      mempalace_search: {
        description: 'Semantic search. Returns verbatim drawer content with similarity scores.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            limit: { type: 'integer', description: 'Max results (default 5)' },
            wing: { type: 'string', description: 'Filter by wing (optional)' },
            room: { type: 'string', description: 'Filter by room (optional)' },
          },
          required: ['query'],
        },
      },
      mempalace_check_duplicate: {
        description: 'Check if content already exists in the palace before filing',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to check' },
            threshold: { type: 'number', description: 'Similarity threshold 0-1 (default 0.9)' },
          },
          required: ['content'],
        },
      },
      mempalace_traverse: {
        description: 'Walk the palace graph from a room to find connected ideas across wings',
        inputSchema: {
          type: 'object',
          properties: {
            start_room: { type: 'string', description: 'Room to start from' },
            max_hops: { type: 'integer', description: 'How many connections to follow (default: 2)' },
          },
          required: ['start_room'],
        },
      },
      mempalace_find_tunnels: {
        description: 'Find rooms that bridge two wings — the hallways connecting different domains',
        inputSchema: {
          type: 'object',
          properties: {
            wing_a: { type: 'string', description: 'First wing (optional)' },
            wing_b: { type: 'string', description: 'Second wing (optional)' },
          },
        },
      },
      mempalace_graph_stats: {
        description: 'Palace graph overview: total rooms, tunnel connections, edges between wings',
        inputSchema: { type: 'object', properties: {} },
      },
      mempalace_add_drawer: {
        description: 'File verbatim content into the palace',
        inputSchema: {
          type: 'object',
          properties: {
            wing: { type: 'string', description: 'Wing (project name)' },
            room: { type: 'string', description: 'Room (aspect)' },
            content: { type: 'string', description: 'Verbatim content to store' },
            source_file: { type: 'string', description: 'Where this came from (optional)' },
            added_by: { type: 'string', description: 'Who is filing this (default: mcp)' },
          },
          required: ['wing', 'room', 'content'],
        },
      },
      mempalace_delete_drawer: {
        description: 'Delete a drawer by ID. Irreversible.',
        inputSchema: {
          type: 'object',
          properties: { drawer_id: { type: 'string', description: 'ID of the drawer to delete' } },
          required: ['drawer_id'],
        },
      },
      mempalace_kg_query: {
        description: 'Query the knowledge graph for an entity\'s relationships',
        inputSchema: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: 'Entity to query' },
            as_of: { type: 'string', description: 'Date filter — only facts valid at this date (YYYY-MM-DD, optional)' },
            direction: { type: 'string', description: 'outgoing, incoming, or both (default: both)' },
          },
          required: ['entity'],
        },
      },
      mempalace_kg_add: {
        description: 'Add a fact to the knowledge graph',
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'The entity doing/being something' },
            predicate: { type: 'string', description: 'The relationship type' },
            object: { type: 'string', description: 'The entity being connected to' },
            valid_from: { type: 'string', description: 'When this became true (YYYY-MM-DD, optional)' },
            source_closet: { type: 'string', description: 'Closet ID where this fact appears (optional)' },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
      mempalace_kg_invalidate: {
        description: 'Mark a fact as no longer true',
        inputSchema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
            ended: { type: 'string', description: 'When it stopped being true (YYYY-MM-DD, default: today)' },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
      mempalace_kg_timeline: {
        description: 'Chronological timeline of facts, optionally for one entity',
        inputSchema: {
          type: 'object',
          properties: { entity: { type: 'string', description: 'Entity to get timeline for (optional)' } },
        },
      },
      mempalace_kg_stats: {
        description: 'Knowledge graph overview',
        inputSchema: { type: 'object', properties: {} },
      },
      mempalace_diary_write: {
        description: 'Write to your personal agent diary in AAAK format',
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Your name' },
            entry: { type: 'string', description: 'Your diary entry in AAAK format' },
            topic: { type: 'string', description: 'Topic tag (optional)' },
          },
          required: ['agent_name', 'entry'],
        },
      },
      mempalace_diary_read: {
        description: 'Read your recent diary entries',
        inputSchema: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Your name' },
            last_n: { type: 'integer', description: 'Number of recent entries (default: 10)' },
          },
          required: ['agent_name'],
        },
      },
    };
  }

  // ── Request handler ───────────────────────────────────────────────────

  async handleRequest(request: MCPRequest): Promise<MCPResponse | null> {
    const { method, params = {}, id } = request;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mempalace', version: VERSION },
        },
      };
    }

    if (method === 'notifications/initialized') return null;

    if (method === 'tools/list') {
      const tools = this.getTools();
      return {
        jsonrpc: '2.0', id,
        result: {
          tools: Object.entries(tools).map(([name, t]) => ({
            name, description: t.description, inputSchema: t.inputSchema,
          })),
        },
      };
    }

    if (method === 'tools/call') {
      const toolName = params.name as string;
      const toolArgs = (params.arguments as Record<string, unknown>) || {};
      const tools = this.getTools();

      if (!(toolName in tools)) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
      }

      // Coerce types from schema
      const props = tools[toolName].inputSchema.properties;
      for (const [key, value] of Object.entries(toolArgs)) {
        const declared = props[key]?.type;
        if (declared === 'integer' && typeof value !== 'number') {
          toolArgs[key] = parseInt(String(value), 10);
        } else if (declared === 'number' && typeof value !== 'number') {
          toolArgs[key] = parseFloat(String(value));
        }
      }

      try {
        const handlerMap: Record<string, (a: any) => any> = {
          mempalace_status: () => this.toolStatus(),
          mempalace_list_wings: () => this.toolListWings(),
          mempalace_list_rooms: (a) => this.toolListRooms(a),
          mempalace_get_taxonomy: () => this.toolGetTaxonomy(),
          mempalace_get_aaak_spec: () => this.toolGetAaakSpec(),
          mempalace_search: (a) => this.toolSearch(a),
          mempalace_check_duplicate: (a) => this.toolCheckDuplicate(a),
          mempalace_traverse: (a) => this.toolTraverse(a),
          mempalace_find_tunnels: (a) => this.toolFindTunnels(a),
          mempalace_graph_stats: () => this.toolGraphStats(),
          mempalace_add_drawer: (a) => this.toolAddDrawer(a),
          mempalace_delete_drawer: (a) => this.toolDeleteDrawer(a),
          mempalace_kg_query: (a) => this.toolKgQuery(a),
          mempalace_kg_add: (a) => this.toolKgAdd(a),
          mempalace_kg_invalidate: (a) => this.toolKgInvalidate(a),
          mempalace_kg_timeline: (a) => this.toolKgTimeline(a),
          mempalace_kg_stats: () => this.toolKgStats(),
          mempalace_diary_write: (a) => this.toolDiaryWrite(a),
          mempalace_diary_read: (a) => this.toolDiaryRead(a),
        };

        const result = await handlerMap[toolName](toolArgs);
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        };
      } catch (e) {
        process.stderr.write(`Tool error in ${toolName}: ${e}\n`);
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Internal tool error' } };
      }
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run the MCP server on stdio.
 *
 * Usage:
 *   import { runMcpServer } from 'mempalace-node';
 *   runMcpServer(); // uses default palace path
 *   runMcpServer('/path/to/palace');
 */
export function runMcpServer(palacePath?: string): void {
  const server = new McpServer(palacePath);
  process.stderr.write('MemPalace MCP Server starting...\n');

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const request = JSON.parse(trimmed) as MCPRequest;
      const response = await server.handleRequest(request);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (e) {
      process.stderr.write(`Server error: ${e}\n`);
    }
  });

  rl.on('close', () => process.exit(0));
}

export { McpServer };
