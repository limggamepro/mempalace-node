/**
 * mempalace-node — Node.js port of MemPalace
 *
 * The highest-scoring AI memory system (96.6% Recall@5), rewritten in TypeScript.
 * Fully local, fully offline. No API calls. No cloud dependencies.
 *
 * Usage:
 *   import { MemoryStack, searchMemories, KnowledgeGraph } from 'mempalace-node';
 *
 *   const stack = new MemoryStack();
 *   console.log(stack.wakeUp());               // L0 + L1 (~600-900 tokens)
 *   console.log(stack.recall({ wing: 'app' })); // L2 on-demand
 *   console.log(await stack.search('pricing')); // L3 deep search
 */

// Config
export { MempalaceConfig } from './config';

// Embedder
export {
  embed, embedBatch, cosineSimilarity, cosineSimilarityF32, cosineDistance,
  setModel, getModel, getEmbeddingDim, EMBEDDING_DIM,
} from './embedder';

// Utilities
export { BoundedMinHeap } from './min-heap';

// Config (model definitions)
export { EMBEDDING_MODELS } from './config';
export type { EmbeddingModelKey } from './config';

// Vector Store interface (backend-agnostic — swap implementations here)
export {
  createStore, registerStoreFactory, setStoreBackend, getStoreBackend, listBackends,
} from './vector-store';
export type {
  VectorStore, DrawerMetadata, WhereFilter,
  GetOptions, GetResult, QueryOptions, QueryResult,
  StoreBackend, StoreFactory,
} from './vector-store';

// SQLite store (default backend, registers itself on import)
export { SqliteVectorStore, PalaceStore, shutdownWorkerPool } from './store';

// Miner (file ingestion + chunking)
export {
  mine, addDrawer, scanProject, chunkText, detectRoom, loadConfig, status,
  GitignoreMatcher, READABLE_EXTENSIONS, SKIP_DIRS, CHUNK_SIZE, CHUNK_OVERLAP,
} from './miner';
export type { RoomConfig, MineConfig, Chunk } from './miner';

// Normalize (chat format conversion)
export { normalize } from './normalize';

// Conversation miner (chat export ingestion)
export { mineConvos, chunkExchanges, detectConvoRoom, scanConvos, CONVO_EXTENSIONS } from './convo-miner';
export type { ConvoChunk } from './convo-miner';

// Searcher (semantic search)
export { searchMemories, checkDuplicate, SearchError } from './searcher';

// Layers (4-layer memory stack)
export { MemoryStack } from './layers';

// Palace graph (BFS traversal)
export { buildGraph, traverse, findTunnels, graphStats } from './graph';

// Knowledge graph (temporal entity-relationship)
export { KnowledgeGraph } from './knowledge';

// AAAK Dialect (lossy structured summary format)
export { Dialect, EMOTION_CODES } from './dialect';
export type { CompressionStats, DialectMetadata, DialectConfig } from './dialect';

// Spellcheck (optional, requires nspell + dictionary-en)
export { spellcheckUserText, spellcheckTranscriptLine, spellcheckTranscript, isSpellcheckAvailable } from './spellcheck';

// MCP Server (for Claude Desktop / Cursor / etc.)
export { runMcpServer, McpServer } from './mcp-server';

// Entity Registry (persistent name/relationship registry)
export { EntityRegistry, COMMON_ENGLISH_WORDS } from './entity-registry';
export type { PersonEntry, RegistryData, LookupResult, SeedPerson, WikiLookupResult } from './entity-registry';

// Entity Detector (auto-detect people/projects from text)
export { extractCandidates, scoreEntity, classifyEntity, detectEntities, scanForDetection } from './entity-detector';
export type { EntityScores, ClassifiedEntity, DetectionResult } from './entity-detector';

// General Extractor (extract decisions/preferences/milestones/problems/emotional)
export { extractMemories } from './general-extractor';
export type { ExtractedMemory } from './general-extractor';

// Room Detector (auto-detect rooms from folder structure)
export { detectRoomsFromFolders, detectRoomsFromFiles, detectRoomsLocal, saveRoomConfig, FOLDER_ROOM_MAP } from './room-detector';
export type { DetectedRoom } from './room-detector';

// Onboarding (first-run setup)
export { runOnboarding, quickSetup, autoDetect, warnAmbiguous, generateAaakBootstrap, DEFAULT_WINGS } from './onboarding';
export type { OnboardingMode, OnboardingPerson, OnboardingConfig } from './onboarding';

// Split mega files (concatenated transcript splitter)
export { splitMegaFiles, splitFile, findSessionBoundaries, isTrueSessionStart, extractTimestamp, extractPeople, extractSubject, loadKnownPeople } from './split-mega-files';
export type { SplitOptions } from './split-mega-files';

// Hooks (session-start, stop, precompact)
export { runHook, hookStop, hookSessionStart, hookPrecompact } from './hooks-cli';
export type { HookName, Harness } from './hooks-cli';

// Instructions
export { getInstructions, runInstructions, AVAILABLE_INSTRUCTIONS } from './instructions-cli';

// CLI entry point
export { main as runCli } from './cli';
