/**
 * vector-store.ts — Abstract interface for vector storage backends.
 *
 * This is the integration point for swapping storage implementations.
 * Currently supported backends:
 *   - 'sqlite' (default)  — better-sqlite3 + brute-force cosine similarity
 *                           Best for ≤10K drawers. Zero native dependencies.
 *   - 'lance' (planned)   — LanceDB with HNSW vector index
 *                           Best for 100K+ drawers. Production-grade.
 *
 * Adding a new backend:
 *   1. Create a class that implements VectorStore
 *   2. Register it via registerStoreFactory('your-backend', factoryFn)
 *   3. Users select it with setStoreBackend('your-backend')
 *
 * The rest of the library (miner, layers, searcher, graph, mcp-server)
 * never imports a concrete store class — only this interface — so
 * swapping is a zero-touch change at the call site.
 */

export interface DrawerMetadata {
  wing?: string;
  room?: string;
  hall?: string;
  source_file?: string;
  chunk_index?: number;
  added_by?: string;
  filed_at?: string;
  source_mtime?: number;
  importance?: number;
  emotional_weight?: number;
  weight?: number;
  date?: string;
  [key: string]: unknown;
}

export interface WhereFilter {
  wing?: string;
  room?: string;
  $and?: Array<Record<string, string>>;
  [key: string]: unknown;
}

export interface GetOptions {
  where?: WhereFilter;
  limit?: number;
  offset?: number;
  includeEmbeddings?: boolean;
}

export interface GetResult {
  ids: string[];
  documents: string[];
  metadatas: DrawerMetadata[];
}

export interface QueryOptions {
  queryText: string;
  nResults?: number;
  where?: WhereFilter;
}

export interface QueryResult {
  documents: string[][];
  metadatas: DrawerMetadata[][];
  distances: number[][];
}

/**
 * Vector store interface — implement this to add a new backend.
 *
 * All operations match ChromaDB's collection API for compatibility:
 *   - upsert(): idempotent insertion (existing IDs are replaced)
 *   - get(): metadata-filtered retrieval (no semantic search)
 *   - query(): semantic search via embedding + similarity
 *   - delete(): remove by ID
 *   - count(): total drawer count
 *   - close(): release resources (close DB connections, etc.)
 */
export interface VectorStore {
  /** Insert or replace a drawer */
  upsert(id: string, document: string, metadata: DrawerMetadata): Promise<void>;

  /** Delete a drawer by ID */
  delete(id: string): void;

  /** Retrieve drawers by metadata filter (no semantic search) */
  get(options?: GetOptions): GetResult;

  /** Semantic search — embeds queryText and returns most similar drawers */
  query(options: QueryOptions): Promise<QueryResult>;

  /** Total number of drawers */
  count(): number;

  /** Release resources (close DB connections, etc.) */
  close(): void;
}

// ── Backend factory registry ────────────────────────────────────────────────

export type StoreBackend = 'sqlite' | 'lance' | string;

export type StoreFactory = (palacePath: string, collectionName?: string) => VectorStore;

const factories = new Map<StoreBackend, StoreFactory>();
let activeBackend: StoreBackend = 'sqlite';

/**
 * Register a new vector store backend.
 *
 * Example (adding LanceDB support):
 *   import { registerStoreFactory } from 'mempalace-node';
 *   import { LanceVectorStore } from './my-lance-store';
 *   registerStoreFactory('lance', (path) => new LanceVectorStore(path));
 */
export function registerStoreFactory(backend: StoreBackend, factory: StoreFactory): void {
  factories.set(backend, factory);
}

/**
 * Set the active backend used by createStore().
 * Call once at startup (e.g. setStoreBackend('lance')).
 */
export function setStoreBackend(backend: StoreBackend): void {
  if (!factories.has(backend)) {
    throw new Error(`Unknown store backend: "${backend}". Available: ${[...factories.keys()].join(', ')}`);
  }
  activeBackend = backend;
}

/** Get the currently active backend name */
export function getStoreBackend(): StoreBackend {
  return activeBackend;
}

/**
 * Create a vector store using the active backend.
 * This is the main entry point used by miner, layers, etc.
 *
 * The default 'sqlite' backend is registered lazily on first call —
 * importing './store' triggers the side-effect registration.
 */
export function createStore(palacePath: string, collectionName = 'mempalace_drawers'): VectorStore {
  // Lazy-load default sqlite backend if not yet registered
  if (activeBackend === 'sqlite' && !factories.has('sqlite')) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./store');
  }
  const factory = factories.get(activeBackend);
  if (!factory) {
    throw new Error(`No factory registered for backend "${activeBackend}". Did you forget to import the backend?`);
  }
  return factory(palacePath, collectionName);
}

/** List all registered backends */
export function listBackends(): StoreBackend[] {
  return [...factories.keys()];
}
