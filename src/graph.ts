/**
 * graph.ts — Graph traversal layer for MemPalace
 *
 * Direct port of mempalace/palace_graph.py.
 *
 * Builds a navigable graph from the palace structure:
 *   - Nodes = rooms (named ideas)
 *   - Edges = shared rooms across wings (tunnels)
 *
 * Enables queries like:
 *   "Start at chromadb-setup in wing_code, walk to wing_myproject"
 *   "Find all rooms connected to riley-college-apps"
 *   "What topics bridge wing_hardware and wing_myproject?"
 *
 * No external graph DB — built from SQLite metadata.
 */

import { createStore } from './vector-store';
import type { VectorStore } from './vector-store';
import { MempalaceConfig } from './config';

interface RoomNode {
  wings: string[];
  halls: string[];
  count: number;
  dates: string[];
}

interface GraphEdge {
  room: string;
  wing_a: string;
  wing_b: string;
  hall: string;
  count: number;
}

export interface TraversalResult {
  room: string;
  wings: string[];
  halls: string[];
  count: number;
  hop: number;
  connected_via?: string[];
}

/**
 * Build the palace graph from stored metadata.
 * Returns nodes (rooms) and edges (tunnels between wings).
 */
export function buildGraph(palacePath?: string): {
  nodes: Record<string, RoomNode>;
  edges: GraphEdge[];
} {
  const cfg = new MempalaceConfig();
  const palace = palacePath || cfg.palacePath;

  let store: VectorStore;
  try {
    store = createStore(palace);
  } catch {
    return { nodes: {}, edges: [] };
  }

  const total = store.count();
  const roomData = new Map<string, {
    wings: Set<string>; halls: Set<string>; count: number; dates: Set<string>;
  }>();

  // Fetch all metadata in batches of 1000 (same as Python)
  let offset = 0;
  while (offset < total) {
    const batch = store.get({ limit: 1000, offset });
    for (const meta of batch.metadatas) {
      const room = (meta.room as string) || '';
      const wing = (meta.wing as string) || '';
      const hall = (meta.hall as string) || '';
      const date = (meta.date as string) || '';

      if (room && room !== 'general' && wing) {
        if (!roomData.has(room)) {
          roomData.set(room, { wings: new Set(), halls: new Set(), count: 0, dates: new Set() });
        }
        const data = roomData.get(room)!;
        data.wings.add(wing);
        if (hall) data.halls.add(hall);
        if (date) data.dates.add(date);
        data.count++;
      }
    }
    if (batch.ids.length === 0) break;
    offset += batch.ids.length;
  }

  store.close();

  // Build edges from rooms that span multiple wings
  const edges: GraphEdge[] = [];
  for (const [room, data] of roomData) {
    const wings = [...data.wings].sort();
    if (wings.length >= 2) {
      for (let i = 0; i < wings.length; i++) {
        for (let j = i + 1; j < wings.length; j++) {
          for (const hall of data.halls) {
            edges.push({ room, wing_a: wings[i], wing_b: wings[j], hall, count: data.count });
          }
        }
      }
    }
  }

  // Convert sets to arrays
  const nodes: Record<string, RoomNode> = {};
  for (const [room, data] of roomData) {
    nodes[room] = {
      wings: [...data.wings].sort(),
      halls: [...data.halls].sort(),
      count: data.count,
      dates: [...data.dates].sort().slice(-5),
    };
  }

  return { nodes, edges };
}

/**
 * Walk the graph from a starting room via BFS.
 * Find connected rooms through shared wings.
 * Equivalent to Python's traverse().
 */
export function traverse(
  startRoom: string,
  palacePath?: string,
  maxHops = 2,
): TraversalResult[] | { error: string; suggestions: string[] } {
  const { nodes } = buildGraph(palacePath);

  if (!(startRoom in nodes)) {
    return {
      error: `Room '${startRoom}' not found`,
      suggestions: fuzzyMatch(startRoom, nodes),
    };
  }

  const start = nodes[startRoom];
  const visited = new Set([startRoom]);
  const results: TraversalResult[] = [{
    room: startRoom,
    wings: start.wings,
    halls: start.halls,
    count: start.count,
    hop: 0,
  }];

  // BFS traversal
  const frontier: Array<[string, number]> = [[startRoom, 0]];
  while (frontier.length > 0) {
    const [currentRoom, depth] = frontier.shift()!;
    if (depth >= maxHops) continue;

    const current = nodes[currentRoom];
    if (!current) continue;
    const currentWings = new Set(current.wings);

    for (const [room, data] of Object.entries(nodes)) {
      if (visited.has(room)) continue;
      const sharedWings = data.wings.filter(w => currentWings.has(w));
      if (sharedWings.length > 0) {
        visited.add(room);
        results.push({
          room,
          wings: data.wings,
          halls: data.halls,
          count: data.count,
          hop: depth + 1,
          connected_via: sharedWings.sort(),
        });
        if (depth + 1 < maxHops) {
          frontier.push([room, depth + 1]);
        }
      }
    }
  }

  // Sort by relevance (hop distance, then count descending)
  results.sort((a, b) => a.hop - b.hop || b.count - a.count);
  return results.slice(0, 50);
}

/**
 * Find rooms that connect two wings (tunnel rooms).
 * Equivalent to Python's find_tunnels().
 */
export function findTunnels(
  wingA?: string,
  wingB?: string,
  palacePath?: string,
): Array<{
  room: string; wings: string[]; halls: string[]; count: number; recent: string;
}> {
  const { nodes } = buildGraph(palacePath);
  const tunnels: Array<{
    room: string; wings: string[]; halls: string[]; count: number; recent: string;
  }> = [];

  for (const [room, data] of Object.entries(nodes)) {
    if (data.wings.length < 2) continue;
    if (wingA && !data.wings.includes(wingA)) continue;
    if (wingB && !data.wings.includes(wingB)) continue;

    tunnels.push({
      room,
      wings: data.wings,
      halls: data.halls,
      count: data.count,
      recent: data.dates.length > 0 ? data.dates[data.dates.length - 1] : '',
    });
  }

  tunnels.sort((a, b) => b.count - a.count);
  return tunnels.slice(0, 50);
}

/**
 * Summary statistics about the palace graph.
 * Equivalent to Python's graph_stats().
 */
export function graphStats(palacePath?: string): {
  total_rooms: number;
  tunnel_rooms: number;
  total_edges: number;
  rooms_per_wing: Record<string, number>;
  top_tunnels: Array<{ room: string; wings: string[]; count: number }>;
} {
  const { nodes, edges } = buildGraph(palacePath);

  const tunnelRooms = Object.values(nodes).filter(n => n.wings.length >= 2).length;
  const wingCounts: Record<string, number> = {};
  for (const data of Object.values(nodes)) {
    for (const w of data.wings) {
      wingCounts[w] = (wingCounts[w] || 0) + 1;
    }
  }

  const topTunnels = Object.entries(nodes)
    .filter(([, d]) => d.wings.length >= 2)
    .sort((a, b) => b[1].wings.length - a[1].wings.length)
    .slice(0, 10)
    .map(([room, d]) => ({ room, wings: d.wings, count: d.count }));

  return {
    total_rooms: Object.keys(nodes).length,
    tunnel_rooms: tunnelRooms,
    total_edges: edges.length,
    rooms_per_wing: wingCounts,
    top_tunnels: topTunnels,
  };
}

/** Simple fuzzy match for room names */
function fuzzyMatch(query: string, nodes: Record<string, RoomNode>, n = 5): string[] {
  const queryLower = query.toLowerCase();
  const scored: Array<[string, number]> = [];

  for (const room of Object.keys(nodes)) {
    if (room.includes(queryLower)) {
      scored.push([room, 1.0]);
    } else if (queryLower.split('-').some(word => room.includes(word))) {
      scored.push([room, 0.5]);
    }
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, n).map(([r]) => r);
}
