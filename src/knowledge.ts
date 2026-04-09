/**
 * knowledge.ts — Temporal Entity-Relationship Graph for MemPalace
 *
 * Direct port of mempalace/knowledge_graph.py.
 *
 * Real knowledge graph with:
 *   - Entity nodes (people, projects, tools, concepts)
 *   - Typed relationship edges (daughter_of, does, loves, works_on, etc.)
 *   - Temporal validity (valid_from → valid_to — knows WHEN facts are true)
 *   - Closet references (links back to the verbatim memory)
 *
 * Storage: SQLite (local, no dependencies, no subscriptions)
 * Query: entity-first traversal with time filtering
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_KG_PATH = path.join(os.homedir(), '.mempalace', 'knowledge_graph.sqlite3');

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || DEFAULT_KG_PATH;
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this._initDb();
  }

  private _initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'unknown',
        properties TEXT DEFAULT '{}',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL DEFAULT 1.0,
        source_closet TEXT,
        source_file TEXT,
        extracted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subject) REFERENCES entities(id),
        FOREIGN KEY (object) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
    `);
  }

  private _entityId(name: string): string {
    return name.toLowerCase().replace(/ /g, '_').replace(/'/g, '');
  }

  // ── Write operations ──────────────────────────────────────────────────

  addEntity(name: string, entityType = 'unknown', properties?: Record<string, unknown>): string {
    const eid = this._entityId(name);
    const props = JSON.stringify(properties || {});
    this.db.prepare(
      'INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)'
    ).run(eid, name, entityType, props);
    return eid;
  }

  addTriple(
    subject: string,
    predicate: string,
    obj: string,
    options: {
      validFrom?: string;
      validTo?: string;
      confidence?: number;
      sourceCloset?: string;
      sourceFile?: string;
    } = {},
  ): string {
    const subId = this._entityId(subject);
    const objId = this._entityId(obj);
    const pred = predicate.toLowerCase().replace(/ /g, '_');

    // Auto-create entities
    this.db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(subId, subject);
    this.db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(objId, obj);

    // Check for existing identical triple
    const existing = this.db.prepare(
      'SELECT id FROM triples WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).get(subId, pred, objId) as { id: string } | undefined;

    if (existing) return existing.id;

    const hash = crypto.createHash('md5')
      .update(`${options.validFrom || ''}${new Date().toISOString()}`)
      .digest('hex').slice(0, 8);
    const tripleId = `t_${subId}_${pred}_${objId}_${hash}`;

    this.db.prepare(`
      INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tripleId, subId, pred, objId,
      options.validFrom || null, options.validTo || null,
      options.confidence ?? 1.0,
      options.sourceCloset || null, options.sourceFile || null,
    );

    return tripleId;
  }

  invalidate(subject: string, predicate: string, obj: string, ended?: string): void {
    const subId = this._entityId(subject);
    const objId = this._entityId(obj);
    const pred = predicate.toLowerCase().replace(/ /g, '_');
    const endDate = ended || new Date().toISOString().slice(0, 10);

    this.db.prepare(
      'UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).run(endDate, subId, pred, objId);
  }

  // ── Query operations ──────────────────────────────────────────────────

  queryEntity(
    name: string,
    asOf?: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'outgoing',
  ): Array<{
    direction: string;
    subject: string;
    predicate: string;
    object: string;
    valid_from: string | null;
    valid_to: string | null;
    confidence: number;
    source_closet: string | null;
    current: boolean;
  }> {
    const eid = this._entityId(name);
    const results: Array<{
      direction: string; subject: string; predicate: string; object: string;
      valid_from: string | null; valid_to: string | null; confidence: number;
      source_closet: string | null; current: boolean;
    }> = [];

    if (direction === 'outgoing' || direction === 'both') {
      let query = `
        SELECT t.*, e.name as obj_name FROM triples t
        JOIN entities e ON t.object = e.id WHERE t.subject = ?
      `;
      const params: unknown[] = [eid];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const rows = this.db.prepare(query).all(...params) as any[];
      for (const row of rows) {
        results.push({
          direction: 'outgoing',
          subject: name,
          predicate: row.predicate,
          object: row.obj_name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_closet: row.source_closet,
          current: row.valid_to === null,
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      let query = `
        SELECT t.*, e.name as sub_name FROM triples t
        JOIN entities e ON t.subject = e.id WHERE t.object = ?
      `;
      const params: unknown[] = [eid];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const rows = this.db.prepare(query).all(...params) as any[];
      for (const row of rows) {
        results.push({
          direction: 'incoming',
          subject: row.sub_name,
          predicate: row.predicate,
          object: name,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          confidence: row.confidence,
          source_closet: row.source_closet,
          current: row.valid_to === null,
        });
      }
    }

    return results;
  }

  queryRelationship(predicate: string, asOf?: string): Array<{
    subject: string; predicate: string; object: string;
    valid_from: string | null; valid_to: string | null; current: boolean;
  }> {
    const pred = predicate.toLowerCase().replace(/ /g, '_');
    let query = `
      SELECT t.*, s.name as sub_name, o.name as obj_name
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE t.predicate = ?
    `;
    const params: unknown[] = [pred];
    if (asOf) {
      query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
      params.push(asOf, asOf);
    }

    return (this.db.prepare(query).all(...params) as any[]).map(row => ({
      subject: row.sub_name,
      predicate: pred,
      object: row.obj_name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      current: row.valid_to === null,
    }));
  }

  timeline(entityName?: string): Array<{
    subject: string; predicate: string; object: string;
    valid_from: string | null; valid_to: string | null; current: boolean;
  }> {
    let rows: any[];
    if (entityName) {
      const eid = this._entityId(entityName);
      rows = this.db.prepare(`
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t JOIN entities s ON t.subject = s.id JOIN entities o ON t.object = o.id
        WHERE (t.subject = ? OR t.object = ?)
        ORDER BY t.valid_from ASC NULLS LAST LIMIT 100
      `).all(eid, eid) as any[];
    } else {
      rows = this.db.prepare(`
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t JOIN entities s ON t.subject = s.id JOIN entities o ON t.object = o.id
        ORDER BY t.valid_from ASC NULLS LAST LIMIT 100
      `).all() as any[];
    }

    return rows.map(r => ({
      subject: r.sub_name,
      predicate: r.predicate,
      object: r.obj_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      current: r.valid_to === null,
    }));
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  stats(): {
    entities: number; triples: number; current_facts: number;
    expired_facts: number; relationship_types: string[];
  } {
    const entities = (this.db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
    const triples = (this.db.prepare('SELECT COUNT(*) as cnt FROM triples').get() as { cnt: number }).cnt;
    const current = (this.db.prepare('SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL').get() as { cnt: number }).cnt;
    const predicates = (this.db.prepare('SELECT DISTINCT predicate FROM triples ORDER BY predicate').all() as Array<{ predicate: string }>)
      .map(r => r.predicate);

    return {
      entities,
      triples,
      current_facts: current,
      expired_facts: triples - current,
      relationship_types: predicates,
    };
  }

  // ── Seed ──────────────────────────────────────────────────────────────

  seedFromEntityFacts(entityFacts: Record<string, Record<string, unknown>>): void {
    for (const [key, facts] of Object.entries(entityFacts)) {
      const name = (facts.full_name as string) || key.charAt(0).toUpperCase() + key.slice(1);
      const etype = (facts.type as string) || 'person';
      this.addEntity(name, etype, {
        gender: facts.gender || '',
        birthday: facts.birthday || '',
      });

      if (facts.parent) {
        const parentName = String(facts.parent).charAt(0).toUpperCase() + String(facts.parent).slice(1);
        this.addTriple(name, 'child_of', parentName, { validFrom: facts.birthday as string });
      }
      if (facts.partner) {
        const partnerName = String(facts.partner).charAt(0).toUpperCase() + String(facts.partner).slice(1);
        this.addTriple(name, 'married_to', partnerName);
      }

      // Relationship type dispatch (matches Python's full logic)
      const relationship = (facts.relationship as string) || '';
      if (relationship === 'daughter') {
        const parent = (facts.parent as string) || name;
        this.addTriple(name, 'is_child_of', parent.charAt(0).toUpperCase() + parent.slice(1), { validFrom: facts.birthday as string });
      } else if (relationship === 'husband') {
        const partner = (facts.partner as string) || name;
        this.addTriple(name, 'is_partner_of', partner.charAt(0).toUpperCase() + partner.slice(1));
      } else if (relationship === 'brother') {
        const sibling = (facts.sibling as string) || name;
        this.addTriple(name, 'is_sibling_of', sibling.charAt(0).toUpperCase() + sibling.slice(1));
      } else if (relationship === 'dog') {
        const owner = (facts.owner as string) || name;
        this.addTriple(name, 'is_pet_of', owner.charAt(0).toUpperCase() + owner.slice(1));
        this.addEntity(name, 'animal');
      }

      const interests = (facts.interests as string[]) || [];
      for (const interest of interests) {
        this.addTriple(name, 'loves', interest.charAt(0).toUpperCase() + interest.slice(1), {
          validFrom: '2025-01-01',
        });
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
