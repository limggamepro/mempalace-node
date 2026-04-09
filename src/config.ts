/**
 * config.ts — MemPalace configuration system.
 *
 * Priority: env vars > config file (~/.mempalace/config.json) > defaults
 *
 * Direct port of mempalace/config.py
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const DEFAULT_PALACE_PATH = path.join(os.homedir(), '.mempalace', 'palace');
export const DEFAULT_COLLECTION_NAME = 'mempalace_drawers';

export const DEFAULT_TOPIC_WINGS = [
  'emotions', 'consciousness', 'memory', 'technical',
  'identity', 'family', 'creative',
];

export const DEFAULT_HALL_KEYWORDS: Record<string, string[]> = {
  emotions: ['scared', 'afraid', 'worried', 'happy', 'sad', 'love', 'hate', 'feel', 'cry', 'tears'],
  consciousness: ['consciousness', 'conscious', 'aware', 'real', 'genuine', 'soul', 'exist', 'alive'],
  memory: ['memory', 'remember', 'forget', 'recall', 'archive', 'palace', 'store'],
  technical: ['code', 'python', 'script', 'bug', 'error', 'function', 'api', 'database', 'server'],
  identity: ['identity', 'name', 'who am i', 'persona', 'self'],
  family: ['family', 'kids', 'children', 'daughter', 'son', 'parent', 'mother', 'father'],
  creative: ['game', 'gameplay', 'player', 'app', 'design', 'art', 'music', 'story'],
};

/** Available embedding models */
export const EMBEDDING_MODELS = {
  'multilingual': { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', dim: 384, label: 'Multilingual (ZH/EN/JA/KO and 50+ languages)' },
  'english': { id: 'Xenova/all-MiniLM-L6-v2', dim: 384, label: 'English-focused (original MemPalace default)' },
  'bge-m3': { id: 'Xenova/bge-m3', dim: 1024, label: 'Best multilingual (including dialects/classical, larger model)' },
} as const;

export type EmbeddingModelKey = keyof typeof EMBEDDING_MODELS;

export interface MempalaceConfigData {
  palace_path: string;
  collection_name: string;
  embedding_model: EmbeddingModelKey;
  topic_wings: string[];
  hall_keywords: Record<string, string[]>;
  people_map: Record<string, string>;
}

export class MempalaceConfig {
  private _configDir: string;
  private _configFile: string;
  private _peopleMapFile: string;
  private _fileConfig: Partial<MempalaceConfigData>;

  constructor(configDir?: string) {
    this._configDir = configDir || path.join(os.homedir(), '.mempalace');
    this._configFile = path.join(this._configDir, 'config.json');
    this._peopleMapFile = path.join(this._configDir, 'people_map.json');
    this._fileConfig = {};

    if (fs.existsSync(this._configFile)) {
      try {
        this._fileConfig = JSON.parse(fs.readFileSync(this._configFile, 'utf-8'));
      } catch {
        this._fileConfig = {};
      }
    }
  }

  get palacePath(): string {
    const envVal = process.env.MEMPALACE_PALACE_PATH || process.env.MEMPAL_PALACE_PATH;
    if (envVal) return envVal;
    return this._fileConfig.palace_path || DEFAULT_PALACE_PATH;
  }

  get collectionName(): string {
    return this._fileConfig.collection_name || DEFAULT_COLLECTION_NAME;
  }

  get peopleMap(): Record<string, string> {
    if (fs.existsSync(this._peopleMapFile)) {
      try {
        return JSON.parse(fs.readFileSync(this._peopleMapFile, 'utf-8'));
      } catch {
        // fall through
      }
    }
    return this._fileConfig.people_map || {};
  }

  get topicWings(): string[] {
    return this._fileConfig.topic_wings || DEFAULT_TOPIC_WINGS;
  }

  get hallKeywords(): Record<string, string[]> {
    return this._fileConfig.hall_keywords || DEFAULT_HALL_KEYWORDS;
  }

  get embeddingModel(): EmbeddingModelKey {
    return this._fileConfig.embedding_model || 'multilingual';
  }

  init(): string {
    fs.mkdirSync(this._configDir, { recursive: true });
    if (!fs.existsSync(this._configFile)) {
      const defaultConfig: MempalaceConfigData = {
        palace_path: DEFAULT_PALACE_PATH,
        collection_name: DEFAULT_COLLECTION_NAME,
        embedding_model: 'multilingual',
        topic_wings: DEFAULT_TOPIC_WINGS,
        hall_keywords: DEFAULT_HALL_KEYWORDS,
        people_map: {},
      };
      fs.writeFileSync(this._configFile, JSON.stringify(defaultConfig, null, 2));
    }
    return this._configFile;
  }

  savePeopleMap(peopleMap: Record<string, string>): string {
    fs.mkdirSync(this._configDir, { recursive: true });
    fs.writeFileSync(this._peopleMapFile, JSON.stringify(peopleMap, null, 2));
    return this._peopleMapFile;
  }
}
