import type {
  AppendTurnInput,
  AppendTurnResult,
  Branch,
  CapabilityInput,
  Event,
  ExperienceInput,
  ExportArchive,
  Json,
  KnowledgeInput,
  MemoryOptions,
  MemoryProposal,
  ObservationInput,
  ProcedureUseInput,
  QuerySpec,
  RecallOptions,
  ResourceBinding,
  Session,
  SourceFence,
  Story,
  World,
  WriteFence,
} from '../shared/domain';
import { MemoryEngine } from './memory';
import { playerProfileAsOf } from './player';

export class StoreError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function digest(value: unknown) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(buffer)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
type Row = Record<string, unknown>;
/** Internal projection SQL is prepared outside D1 and committed with source events. */
export interface TurnProjection {
  fingerprint: unknown;
  advanceOwnerEpoch?: boolean;
  prepare(
    events: { eventId: string; sourceId: string; seq: number }[],
    at: string,
  ): Promise<QuerySpec[]>;
}
const string = (r: Row, key: string) => String(r[key] ?? '');
export function worldRow(r: Row): World {
  return {
    id: string(r, 'id'),
    ownerId: string(r, 'owner_id'),
    name: string(r, 'name'),
    description: string(r, 'description'),
    createdAt: string(r, 'created_at'),
    updatedAt: string(r, 'updated_at'),
  };
}
export function storyRow(r: Row): Story {
  return {
    id: string(r, 'id'),
    ownerId: string(r, 'owner_id'),
    worldId: string(r, 'world_id'),
    name: string(r, 'name'),
    characterIds: json(r.character_ids_json, []),
    worldbookIds: json(r.worldbook_ids_json, []),
    playerCharacterId: r.player_character_id == null ? null : string(r, 'player_character_id'),
    createdAt: string(r, 'created_at'),
    updatedAt: string(r, 'updated_at'),
  };
}
export function branchRow(r: Row): Branch {
  return {
    id: string(r, 'id'),
    ownerId: string(r, 'owner_id'),
    storyId: string(r, 'story_id'),
    name: string(r, 'name'),
    parentBranchId: r.parent_branch_id == null ? null : string(r, 'parent_branch_id'),
    forkSeq: Number(r.fork_seq),
    headSeq: Number(r.head_seq),
    revision: Number(r.revision),
    projectionRevision: Number(r.projection_revision),
    scene: json(r.scene_json, {}),
    createdAt: string(r, 'created_at'),
  };
}
export function sessionRow(r: Row): Session {
  return {
    id: string(r, 'id'),
    ownerId: string(r, 'owner_id'),
    branchId: string(r, 'branch_id'),
    name: string(r, 'name'),
    createdAt: string(r, 'created_at'),
    updatedAt: string(r, 'updated_at'),
  };
}
export function eventRow(r: Row): Event {
  return {
    id: string(r, 'id'),
    ownerId: string(r, 'owner_id'),
    storyId: string(r, 'story_id'),
    branchId: string(r, 'branch_id'),
    sessionId: r.session_id == null ? null : string(r, 'session_id'),
    sourceId: string(r, 'source_id'),
    seq: Number(r.seq),
    role: string(r, 'role'),
    speakerId: r.speaker_id == null ? null : string(r, 'speaker_id'),
    text: r.source_status === 'deleted' ? '' : string(r, 'source_text'),
    sceneTime: Number(r.scene_time),
    storyTime: r.story_time == null ? null : string(r, 'story_time'),
    knownBy: json(r.known_by_json, []),
    createdAt: string(r, 'created_at'),
    deleted: r.source_status === 'deleted',
  };
}

/** D1 batches are the only write transaction primitive; every read-before-write has a CAS guard. */
export class Store {
  readonly memory: MemoryEngine;
  constructor(
    readonly db: D1Database,
    readonly ownerId: string,
  ) {
    if (!ownerId || ownerId.length > 300) throw new StoreError('OWNER', 'Invalid owner', 400);
    this.memory = new MemoryEngine(this);
  }
  statement(sql: string, params: unknown[] = []) {
    return this.db
      .prepare(sql)
      .bind(
        ...params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)),
      );
  }
  async all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    const r = await this.statement(sql, params).all<T>();
    if (!r.success) throw new StoreError('DATABASE', r.error || 'Query failed', 500);
    return r.results ?? [];
  }
  async one<T = Row>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.statement(sql, params).first<T>();
  }
  async run(sql: string, ...params: unknown[]) {
    return this.statement(sql, params).run();
  }
  async batch(specs: QuerySpec[]) {
    if (!specs.length) return [];
    try {
      return await this.db.batch(specs.map((s) => this.statement(s.sql, s.params)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/FENCE|CHECK constraint failed|SOURCE_SCOPE|UNIQUE constraint failed/.test(message))
        throw new StoreError('STALE_WRITE', 'State changed; refresh and retry.');
      throw e;
    }
  }
  guard(condition: string, params: unknown[] = []): QuerySpec {
    return {
      sql: `INSERT INTO write_guards(token,ok) VALUES(?,CASE WHEN (${condition}) THEN 1 ELSE 0 END)`,
      params: [uuid(), ...params],
    };
  }
  async ensureOwner() {
    await this.run(
      'INSERT OR IGNORE INTO owners(owner_id,created_at) VALUES(?,?)',
      this.ownerId,
      now(),
    );
  }
  async ownerEpoch() {
    await this.ensureOwner();
    const r = await this.one<{ deletion_epoch: number }>(
      'SELECT deletion_epoch FROM owners WHERE owner_id=?',
      this.ownerId,
    );
    return r!.deletion_epoch;
  }
  epochGuard(epoch: number) {
    return this.guard('EXISTS(SELECT 1 FROM owners WHERE owner_id=? AND deletion_epoch=?)', [
      this.ownerId,
      epoch,
    ]);
  }
  sourceGuards(fences: SourceFence[]) {
    return fences.map((f) =>
      this.guard(
        "EXISTS(SELECT 1 FROM sources WHERE id=? AND owner_id=? AND version=? AND generation=? AND status='active')",
        [f.sourceId, this.ownerId, f.version, f.generation],
      ),
    );
  }
  cleanupGuards(): QuerySpec {
    return { sql: 'DELETE FROM write_guards' };
  }
  async createWorld(input: { name?: string; description?: string } | string = {}) {
    await this.ensureOwner();
    const data = typeof input === 'string' ? { name: input } : input;
    const id = uuid(),
      at = now();
    await this.run(
      'INSERT INTO worlds(id,owner_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      id,
      this.ownerId,
      data.name?.trim() || '新世界',
      data.description || '',
      at,
      at,
    );
    return worldRow(
      (await this.one('SELECT * FROM worlds WHERE id=? AND owner_id=?', id, this.ownerId))!,
    );
  }
  async listWorlds() {
    return (
      await this.all('SELECT * FROM worlds WHERE owner_id=? ORDER BY created_at DESC', this.ownerId)
    ).map(worldRow);
  }
  async getWorld(id: string) {
    const r = await this.one('SELECT * FROM worlds WHERE id=? AND owner_id=?', id, this.ownerId);
    if (!r) throw new StoreError('NOT_FOUND', 'World not found', 404);
    return worldRow(r);
  }
  async createStory(input: {
    worldId: string;
    name?: string;
    characterIds?: string[];
    worldbookIds?: string[];
    playerCharacterId?: string;
  }) {
    await this.getWorld(input.worldId);
    const id = uuid(),
      branchId = uuid(),
      at = now(),
      assets: ResourceBinding[] = [];
    for (const assetId of [
      ...new Set([...(input.characterIds ?? []), ...(input.worldbookIds ?? [])]),
    ]) {
      const a = await this.one<{ revision: number; kind: string }>(
        'SELECT revision,kind FROM assets WHERE id=? AND owner_id=?',
        assetId,
        this.ownerId,
      );
      if (!a) throw new StoreError('ASSET_NOT_FOUND', 'Selected asset not found', 404);
      assets.push({ assetId, revision: a.revision, kind: a.kind });
    }
    await this.batch([
      {
        sql: 'INSERT INTO stories(id,owner_id,world_id,name,character_ids_json,worldbook_ids_json,player_character_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          this.ownerId,
          input.worldId,
          input.name?.trim() || '新故事',
          JSON.stringify(input.characterIds || []),
          JSON.stringify(input.worldbookIds || []),
          input.playerCharacterId ?? null,
          at,
          at,
        ],
      },
      {
        sql: 'INSERT INTO branches(id,owner_id,story_id,name,created_at) VALUES(?,?,?,?,?)',
        params: [branchId, this.ownerId, id, '主线', at],
      },
      {
        sql: 'INSERT INTO branch_lineage(branch_id,ancestor_id,depth) VALUES(?,?,0)',
        params: [branchId, branchId],
      },
      ...assets.map((a) => ({
        sql: 'INSERT INTO resource_bindings(id,owner_id,branch_id,asset_id,revision,kind,recorded_seq,created_at) VALUES(?,?,?,?,?,?,0,?)',
        params: [uuid(), this.ownerId, branchId, a.assetId, a.revision, a.kind, at],
      })),
    ]);
    return { ...(await this.getStory(id)), branchId };
  }
  async getStory(id: string) {
    const r = await this.one('SELECT * FROM stories WHERE id=? AND owner_id=?', id, this.ownerId);
    if (!r) throw new StoreError('NOT_FOUND', 'Story not found', 404);
    return storyRow(r);
  }
  async listStories(worldId?: string) {
    return (
      await this.all(
        `SELECT * FROM stories WHERE owner_id=? ${worldId ? 'AND world_id=?' : ''} ORDER BY created_at DESC`,
        this.ownerId,
        ...(worldId ? [worldId] : []),
      )
    ).map(storyRow);
  }
  async getBranch(id: string) {
    const r = await this.one('SELECT * FROM branches WHERE id=? AND owner_id=?', id, this.ownerId);
    if (!r) throw new StoreError('NOT_FOUND', 'Branch not found', 404);
    const branch = branchRow(r);
    const player = await playerProfileAsOf(this, id, branch.headSeq);
    delete branch.scene.playerProfile;
    delete branch.scene.playerProfileSourceId;
    if (player)
      Object.assign(branch.scene, {
        playerProfile: player.profile,
        playerProfileSourceId: player.sourceId,
      });
    return branch;
  }
  async listBranches(storyId: string) {
    await this.getStory(storyId);
    return (
      await this.all(
        'SELECT * FROM branches WHERE owner_id=? AND story_id=? ORDER BY created_at',
        this.ownerId,
        storyId,
      )
    ).map(branchRow);
  }
  async createSession(input: { branchId: string; name?: string }) {
    await this.getBranch(input.branchId);
    const id = uuid(),
      at = now();
    await this.run(
      'INSERT INTO sessions(id,owner_id,branch_id,name,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      id,
      this.ownerId,
      input.branchId,
      input.name?.trim() || '新聊天',
      at,
      at,
    );
    return sessionRow((await this.one('SELECT * FROM sessions WHERE id=?', id))!);
  }
  async getSession(id: string) {
    const r = await this.one('SELECT * FROM sessions WHERE owner_id=? AND id=?', this.ownerId, id);
    if (!r) throw new StoreError('NOT_FOUND', 'Session not found', 404);
    return sessionRow(r);
  }
  async listSessions(branchId: string) {
    await this.getBranch(branchId);
    return (
      await this.all(
        'SELECT * FROM sessions WHERE owner_id=? AND branch_id=? ORDER BY created_at DESC',
        this.ownerId,
        branchId,
      )
    ).map(sessionRow);
  }
  async getEvents(
    branchId: string,
    options: { asOfSeq?: number; limit?: number; afterSeq?: number; sessionId?: string } = {},
  ) {
    const branch = await this.getBranch(branchId),
      limit = Math.max(1, Math.min(options.limit ?? 500, 2000)),
      asof = Math.min(options.asOfSeq ?? branch.headSeq, branch.headSeq);
    const rows = await this.all(
      `SELECT e.*,s.text AS source_text,s.status AS source_status FROM events e JOIN sources s ON s.id=e.source_id JOIN branch_lineage l ON l.ancestor_id=e.branch_id AND l.branch_id=? WHERE e.owner_id=? AND e.seq<=? AND (l.max_seq IS NULL OR e.seq<=l.max_seq) AND e.seq>? ${options.sessionId ? 'AND e.session_id=?' : ''} ORDER BY e.seq ASC LIMIT ?`,
      branchId,
      this.ownerId,
      asof,
      options.afterSeq ?? -1,
      ...(options.sessionId ? [options.sessionId] : []),
      limit,
    );
    return rows.map(eventRow);
  }
  /** Suppression is derived from immutable forget revisions, so existing lineage
   * sequence and rowid fences also freeze it correctly at a fork. */
  async forgottenSpans(branchId: string, asOfSeq?: number) {
    const branch = await this.getBranch(branchId);
    return this.all<{ sourceId: string; start: number; end: number }>(
      `SELECT DISTINCT p.source_id AS sourceId,p.start_offset AS start,p.end_offset AS end FROM memory_versions f JOIN branch_lineage l ON l.ancestor_id=f.branch_id AND l.branch_id=? JOIN memory_evidence e ON e.memory_id=f.supersedes_id JOIN source_spans p ON p.id=e.span_id WHERE f.owner_id=? AND f.status='forgotten' AND f.recorded_seq<=? AND (l.max_seq IS NULL OR f.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR f.rowid<=l.max_memory_rowid)`,
      branchId,
      this.ownerId,
      Math.min(asOfSeq ?? branch.headSeq, branch.headSeq),
    );
  }
  /** Audit reads retain original events; model context omits sources containing
   * explicitly forgotten spans, including full raw-message fallback. */
  async getRecallEvents(branchId: string, options: Parameters<Store['getEvents']>[1] = {}) {
    const events = await this.getEvents(branchId, options),
      suppressed = new Set(
        (await this.forgottenSpans(branchId, options?.asOfSeq)).map((span) => span.sourceId),
      );
    return events.filter((event) => !suppressed.has(event.sourceId));
  }
  /** Recompute a materialized head with the same valid-time rule used by reads. */
  memoryHeadSpec(branchId: string, key?: string): QuerySpec {
    return {
      sql: `WITH visible AS (
      SELECT m.*,m.rowid AS version_order,l.depth FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=? JOIN branches b ON b.id=l.branch_id
      WHERE m.owner_id=? AND m.recorded_seq<=b.head_seq AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid) ${key == null ? '' : 'AND m.memory_key=?'}
    ), unsuperseded AS (SELECT m.* FROM visible m WHERE NOT EXISTS(SELECT 1 FROM visible n WHERE n.supersedes_id=m.id OR (n.memory_key=m.memory_key AND n.id<>m.id AND n.recorded_seq>=m.recorded_seq AND json_extract(n.data_json,'$.correction')=1 AND COALESCE(n.valid_from,-1e99)<=COALESCE(m.valid_from,1e99)))), ranked AS (
      SELECT m.*,ROW_NUMBER() OVER(PARTITION BY memory_key ORDER BY CASE WHEN status IN ('forgotten','invalidated') THEN 1 ELSE 0 END DESC,COALESCE(valid_from,-1e99) DESC,recorded_seq DESC,version_order DESC,depth ASC) AS rank FROM unsuperseded m
    ) INSERT INTO memory_heads(branch_id,memory_key,memory_id) SELECT ?,memory_key,id FROM ranked WHERE rank=1
      ON CONFLICT(branch_id,memory_key) DO UPDATE SET memory_id=excluded.memory_id`,
      params: [branchId, this.ownerId, ...(key == null ? [] : [key]), branchId],
    };
  }
  async fork(input: { branchId: string; atSeq: number; name?: string }) {
    const parent = await this.getBranch(input.branchId);
    if (!Number.isInteger(input.atSeq) || input.atSeq < 0 || input.atSeq > parent.headSeq)
      throw new StoreError('FORK_POINT', 'Invalid fork point', 400);
    const id = uuid(),
      at = now(),
      epoch = await this.ownerEpoch(),
      scene = await this.sceneAsOf(parent.id, input.atSeq);
    await this.batch([
      this.epochGuard(epoch),
      this.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND head_seq=? AND revision=?)',
        [parent.id, this.ownerId, parent.headSeq, parent.revision],
      ),
      {
        sql: 'INSERT INTO branches(id,owner_id,story_id,name,parent_branch_id,fork_seq,head_seq,scene_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          this.ownerId,
          parent.storyId,
          input.name?.trim() || `分支 · ${input.atSeq}`,
          parent.id,
          input.atSeq,
          input.atSeq,
          JSON.stringify(scene),
          at,
        ],
      },
      {
        sql: `INSERT INTO branch_lineage(branch_id,ancestor_id,max_seq,max_memory_rowid,max_grant_rowid,max_binding_rowid,max_capability_rowid,depth) SELECT ?,ancestor_id,CASE WHEN max_seq IS NULL OR max_seq>? THEN ? ELSE max_seq END,COALESCE(max_memory_rowid,(SELECT COALESCE(MAX(rowid),0) FROM memory_versions)),COALESCE(max_grant_rowid,(SELECT COALESCE(MAX(rowid),0) FROM knowledge_grants)),COALESCE(max_binding_rowid,(SELECT COALESCE(MAX(rowid),0) FROM resource_bindings)),COALESCE(max_capability_rowid,(SELECT COALESCE(MAX(rowid),0) FROM capability_versions)),depth+1 FROM branch_lineage WHERE branch_id=?`,
        params: [id, input.atSeq, input.atSeq, parent.id],
      },
      {
        sql: 'INSERT INTO branch_lineage(branch_id,ancestor_id,depth) VALUES(?,?,0)',
        params: [id, id],
      },
      {
        sql: 'INSERT INTO memory_event_applications(branch_id,event_id,event_seq,extractor_version,created_at) SELECT ?,event_id,event_seq,extractor_version,? FROM memory_event_applications WHERE branch_id=? AND event_seq<=?',
        params: [id, at, parent.id, input.atSeq],
      },
      {
        sql: 'INSERT INTO memory_cursors(branch_id,extractor_version,applied_seq,updated_at) SELECT ?,extractor_version,MIN(applied_seq,?),? FROM memory_cursors WHERE branch_id=?',
        params: [id, input.atSeq, at, parent.id],
      },
      this.memoryHeadSpec(id),
      {
        sql: 'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        params: [
          uuid(),
          this.ownerId,
          id,
          'memory',
          JSON.stringify({
            ownerId: this.ownerId,
            branchId: id,
            parentBranchId: parent.id,
            throughSeq: input.atSeq,
            rebuild: true,
            ownerEpoch: epoch,
          }),
          at,
          at,
        ],
      },
      this.cleanupGuards(),
    ]);
    return this.getBranch(id);
  }
  async appendTurn(input: AppendTurnInput, projection?: TurnProjection): Promise<AppendTurnResult> {
    const branch = await this.getBranch(input.branchId),
      session = await this.getSession(input.sessionId);
    if (session.branchId !== branch.id)
      throw new StoreError('SESSION_SCOPE', 'Session belongs to another branch', 400);
    if (
      !input.requestId ||
      input.requestId.length > 200 ||
      !input.messages.length ||
      input.messages.length > 20
    )
      throw new StoreError('TURN_INPUT', 'Invalid turn', 400);
    for (const m of input.messages)
      if (!m.text.trim() || m.text.length > 200000)
        throw new StoreError('TURN_TEXT', 'Empty or oversized message', 400);
    const payloadHash = await digest({
      messages: input.messages,
      scene: input.scene,
      resources: input.resourceUpdates,
      ...(projection ? { projection: projection.fingerprint } : {}),
    });
    const existing = await this.one<{ payload_hash: string }>(
      'SELECT payload_hash FROM turns WHERE owner_id=? AND branch_id=? AND request_id=?',
      this.ownerId,
      branch.id,
      input.requestId,
    );
    if (existing) {
      if (existing.payload_hash !== payloadHash)
        throw new StoreError('IDEMPOTENCY_REUSE', 'Request id reused with different content');
      return { branch, events: await this.turnEvents(branch.id, input.requestId), replayed: true };
    }
    const story = await this.getStory(branch.storyId),
      expected = input.expectedHead ?? branch.headSeq,
      epoch = input.ownerEpoch ?? (await this.ownerEpoch()),
      at = now(),
      last = expected + input.messages.length;
    const statements: QuerySpec[] = [
      this.epochGuard(epoch),
      ...this.sourceGuards(input.sourceFence ?? []),
      {
        sql: `UPDATE branches SET head_seq=?,revision=revision+1,projection_revision=projection_revision+1,scene_json=? WHERE id=? AND owner_id=? AND head_seq=? ${input.expectedProjectionRevision == null ? '' : 'AND projection_revision=?'}`,
        params: [
          last,
          JSON.stringify(input.scene ?? branch.scene),
          branch.id,
          this.ownerId,
          expected,
          ...(input.expectedProjectionRevision == null ? [] : [input.expectedProjectionRevision]),
        ],
      },
      this.guard('changes()=1'),
      {
        sql: 'INSERT INTO turns(id,owner_id,branch_id,session_id,request_id,first_seq,last_seq,payload_hash,owner_epoch,task_id,task_attempt,task_cancel_epoch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          uuid(),
          this.ownerId,
          branch.id,
          session.id,
          input.requestId,
          expected + 1,
          last,
          payloadHash,
          epoch,
          input.taskFence?.taskId ?? null,
          input.taskFence?.attempt ?? null,
          input.taskFence?.cancelEpoch ?? null,
          at,
        ],
      },
    ];
    const events: { eventId: string; sourceId: string; seq: number }[] = [];
    for (const [i, m] of input.messages.entries()) {
      const eventId = uuid(),
        sourceId = uuid(),
        seq = expected + i + 1,
        known = [...new Set(m.knownBy ?? [])];
      events.push({ eventId, sourceId, seq });
      statements.push(
        {
          sql: 'INSERT INTO sources(id,owner_id,world_id,story_id,branch_id,event_id,kind,text,known_by_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          params: [
            sourceId,
            this.ownerId,
            story.worldId,
            story.id,
            branch.id,
            eventId,
            'event',
            m.text,
            JSON.stringify(known),
            at,
          ],
        },
        {
          sql: 'INSERT INTO events(id,owner_id,story_id,branch_id,session_id,source_id,seq,role,speaker_id,scene_time,story_time,known_by_json,request_id,ordinal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          params: [
            eventId,
            this.ownerId,
            story.id,
            branch.id,
            session.id,
            sourceId,
            seq,
            m.role,
            m.speakerId ?? null,
            m.sceneTime ?? seq,
            m.storyTime ?? null,
            JSON.stringify(known),
            input.requestId,
            i,
            at,
          ],
        },
      );
    }
    statements.push({
      sql: 'INSERT INTO scene_snapshots(branch_id,event_seq,scene_json,created_at) VALUES(?,?,?,?)',
      params: [branch.id, last, JSON.stringify(input.scene ?? branch.scene), at],
    });
    for (const a of input.resourceUpdates ?? [])
      statements.push(
        this.guard(
          'EXISTS(SELECT 1 FROM asset_revisions ar JOIN assets a ON a.id=ar.asset_id WHERE ar.asset_id=? AND ar.revision=? AND a.owner_id=?)',
          [a.assetId, a.revision, this.ownerId],
        ),
        {
          sql: 'INSERT INTO resource_bindings(id,owner_id,branch_id,asset_id,revision,kind,recorded_seq,created_at) VALUES(?,?,?,?,?,?,?,?)',
          params: [uuid(), this.ownerId, branch.id, a.assetId, a.revision, a.kind, last, at],
        },
      );
    statements.push({
      sql: 'UPDATE sessions SET updated_at=? WHERE id=? AND owner_id=?',
      params: [at, session.id, this.ownerId],
    });
    if (input.taskFence)
      statements.push(
        {
          sql: "UPDATE tasks SET status='completed',draft_text=?,updated_at=? WHERE id=? AND owner_id=? AND attempt=? AND cancel_epoch=? AND status IN ('running','validating','committing')",
          params: [
            input.messages
              .filter((m) => m.role === 'assistant')
              .map((m) => m.text)
              .join('\n'),
            at,
            input.taskFence.taskId,
            this.ownerId,
            input.taskFence.attempt,
            input.taskFence.cancelEpoch,
          ],
        },
        this.guard('changes()=1'),
      );
    if (projection) statements.push(...(await projection.prepare(events, at)));
    if (projection?.advanceOwnerEpoch)
      statements.push({
        sql: 'UPDATE owners SET deletion_epoch=deletion_epoch+1 WHERE owner_id=?',
        params: [this.ownerId],
      });
    statements.push(
      {
        sql: 'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        params: [
          uuid(),
          this.ownerId,
          branch.id,
          'memory',
          JSON.stringify({
            ownerId: this.ownerId,
            branchId: branch.id,
            taskId: input.taskFence?.taskId,
            attempt: input.taskFence?.attempt,
            eventIds: events.map((e) => e.eventId),
            throughSeq: last,
            ownerEpoch: epoch + (projection?.advanceOwnerEpoch ? 1 : 0),
            sourceFence: events.map((e) => ({ sourceId: e.sourceId, version: 1, generation: 0 })),
          }),
          at,
          at,
        ],
      },
      this.cleanupGuards(),
    );
    try {
      await this.batch(statements);
    } catch (e) {
      const replay = await this.one<{ payload_hash: string }>(
        'SELECT payload_hash FROM turns WHERE owner_id=? AND branch_id=? AND request_id=?',
        this.ownerId,
        branch.id,
        input.requestId,
      );
      if (replay?.payload_hash === payloadHash)
        return {
          branch: await this.getBranch(branch.id),
          events: await this.turnEvents(branch.id, input.requestId),
          replayed: true,
        };
      throw e;
    }
    return {
      branch: await this.getBranch(branch.id),
      events: await this.turnEvents(branch.id, input.requestId),
      replayed: false,
    };
  }
  private async turnEvents(branchId: string, requestId: string) {
    return (
      await this.all(
        'SELECT e.*,s.text AS source_text,s.status AS source_status FROM events e JOIN sources s ON s.id=e.source_id WHERE e.branch_id=? AND e.owner_id=? AND e.request_id=? ORDER BY e.ordinal',
        branchId,
        this.ownerId,
        requestId,
      )
    ).map(eventRow);
  }
  async source(sourceId: string) {
    const r = await this.one(
      'SELECT * FROM sources WHERE id=? AND owner_id=?',
      sourceId,
      this.ownerId,
    );
    if (!r) throw new StoreError('NOT_FOUND', 'Source not found', 404);
    return r;
  }
  async createGlobalSource(input: {
    worldId: string;
    kind?: string;
    assetId?: string;
    version?: number;
    text: string;
    knownBy?: string[];
  }) {
    await this.getWorld(input.worldId);
    const id = uuid();
    await this.run(
      'INSERT INTO sources(id,owner_id,world_id,kind,asset_id,version,text,known_by_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      this.ownerId,
      input.worldId,
      input.kind ?? 'worldbook',
      input.assetId ?? null,
      input.version ?? 1,
      input.text,
      JSON.stringify(input.knownBy ?? []),
      now(),
    );
    return { sourceId: id, version: input.version ?? 1, generation: 0 };
  }
  async sceneAsOf(branchId: string, seq: number) {
    await this.getBranch(branchId);
    const r = await this.one<{ scene_json: string }>(
      `SELECT ss.scene_json FROM scene_snapshots ss JOIN branch_lineage l ON l.ancestor_id=ss.branch_id AND l.branch_id=? WHERE ss.event_seq<=? AND (l.max_seq IS NULL OR ss.event_seq<=l.max_seq) ORDER BY ss.event_seq DESC,l.depth ASC LIMIT 1`,
      branchId,
      seq,
    );
    const scene = json<Record<string, Json>>(r?.scene_json, {});
    const player = await playerProfileAsOf(this, branchId, seq);
    delete scene.playerProfile;
    delete scene.playerProfileSourceId;
    if (player)
      Object.assign(scene, {
        playerProfile: player.profile,
        playerProfileSourceId: player.sourceId,
      });
    return scene;
  }
  async getResourceBindings(branchId: string, asOfSeq?: number): Promise<ResourceBinding[]> {
    const b = await this.getBranch(branchId);
    return this.all<ResourceBinding>(
      `SELECT asset_id AS assetId,revision,kind FROM (SELECT rb.*,ROW_NUMBER() OVER(PARTITION BY rb.asset_id ORDER BY rb.recorded_seq DESC,rb.rowid DESC,l.depth ASC) AS rank FROM resource_bindings rb JOIN branch_lineage l ON l.ancestor_id=rb.branch_id AND l.branch_id=? WHERE rb.owner_id=? AND rb.recorded_seq<=? AND (l.max_seq IS NULL OR rb.recorded_seq<=l.max_seq) AND (l.max_binding_rowid IS NULL OR rb.rowid<=l.max_binding_rowid)) WHERE rank=1`,
      branchId,
      this.ownerId,
      asOfSeq ?? b.headSeq,
    );
  }
  async applyResourceUpdates(branchId: string, assetIds: string[]) {
    const b = await this.getBranch(branchId),
      bindings: ResourceBinding[] = [];
    for (const assetId of [...new Set(assetIds)]) {
      const r = await this.one<{ kind: string; revision: number }>(
        'SELECT kind,revision FROM assets WHERE id=? AND owner_id=?',
        assetId,
        this.ownerId,
      );
      if (!r) throw new StoreError('NOT_FOUND', 'Asset not found', 404);
      bindings.push({ assetId, ...r });
    }
    const session =
      (await this.listSessions(branchId))[0] ??
      (await this.createSession({ branchId, name: '资料变更' }));
    await this.appendTurn({
      branchId,
      sessionId: session.id,
      requestId: uuid(),
      expectedHead: b.headSeq,
      messages: [{ role: 'correction', text: `应用资料版本 ${JSON.stringify(bindings)}` }],
      resourceUpdates: bindings,
    });
    return this.getResourceBindings(branchId);
  }
  memories(branchId: string, options: MemoryOptions = {}) {
    return this.memory.memories(branchId, options);
  }
  observationPage(branchId: string, options: Parameters<MemoryEngine['observationPage']>[1]) {
    return this.memory.observationPage(branchId, options);
  }
  async compressionStatus(branchId: string) {
    const branch = await this.getBranch(branchId),
      epoch = await this.ownerEpoch();
    const rows = await this.all<{ scope: string; revision: number; state_json: string }>(
      'SELECT scope,revision,state_json FROM observation_progress WHERE branch_id=? ORDER BY scope',
      branchId,
    );
    return rows.map((row) => {
      const state = json<Record<string, Json>>(row.state_json, {});
      return {
        scope: row.scope,
        revision: row.revision,
        ...state,
        current: state.epoch === epoch,
        pendingEvents: Math.max(
          0,
          branch.headSeq - (state.epoch === epoch ? Number(state.throughSeq ?? 0) : 0),
        ),
      };
    });
  }
  async narrativeCursor(branchId: string) {
    const epoch = await this.ownerEpoch();
    const row = await this.one<{ state_json: string }>(
      'SELECT state_json FROM observation_progress WHERE branch_id=? AND scope=?',
      branchId,
      'director:narrative',
    );
    const state = json<Record<string, Json>>(row?.state_json, {});
    return state.epoch === epoch ? Number(state.throughSeq ?? 0) : 0;
  }
  memoryVersions(branchId: string, memoryId: string) {
    return this.memory.versions(branchId, memoryId);
  }
  recall(branchId: string, query: string, options: RecallOptions = {}) {
    return this.memory.recall(branchId, query, options);
  }
  propose(branchId: string, proposal: MemoryProposal) {
    return this.memory.propose(branchId, proposal);
  }
  extract(
    branchId: string,
    input: {
      eventIds?: string[];
      proposals: MemoryProposal[];
      cursor?: number;
      sourceFence?: SourceFence[];
      ownerEpoch?: number;
      extractorVersion?: string;
    },
  ) {
    return this.memory.extract(branchId, input);
  }
  activateObservation(input: ObservationInput) {
    return this.memory.activateObservation(input);
  }
  correct(
    branchId: string,
    memoryId: string,
    input: { text: string; value: Json; evidence: MemoryProposal['evidence']; validFrom?: number },
  ) {
    return this.memory.correct(branchId, memoryId, input);
  }
  authorCorrection(input: Parameters<MemoryEngine['authorCorrection']>[0]) {
    return this.memory.authorCorrection(input);
  }
  forget(branchId: string, memoryId: string, reason = '用户遗忘') {
    return this.memory.forget(branchId, memoryId, reason);
  }
  deleteSource(sourceId: string, reason = '用户删除来源') {
    return this.memory.deleteSource(sourceId, reason);
  }
  addExperience(input: ExperienceInput) {
    return this.memory.addExperience(input);
  }
  useProcedure(input: ProcedureUseInput) {
    return this.memory.useProcedure(input);
  }
  grantSource(
    branchId: string,
    sourceId: string,
    characterId: string,
    status: 'grant' | 'revoke' = 'grant',
  ) {
    return this.memory.grantSource(branchId, sourceId, characterId, status);
  }
  grantKnowledge(input: KnowledgeInput) {
    return this.memory.grantKnowledge(input);
  }
  readSourceSpan(
    branchId: string,
    sourceId: string,
    options: Parameters<MemoryEngine['readSourceSpan']>[2] = {},
  ) {
    return this.memory.readSourceSpan(branchId, sourceId, options);
  }
  capabilities(branchId: string, actorId?: string) {
    return this.memory.capabilities(branchId, actorId);
  }
  listCapabilities(branchId: string, actorId?: string) {
    return this.memory.capabilities(branchId, actorId);
  }
  setCapability(input: CapabilityInput) {
    return this.memory.setCapability(input);
  }
  addCapability(
    input: {
      branchId: string;
      actorId: string;
      capability?: string;
      name?: string;
      level?: string;
      status?: 'available' | 'lost' | 'uncertain';
      data?: Record<string, Json>;
      evidence: MemoryProposal['evidence'];
    } & WriteFence,
  ) {
    return this.memory.setCapability({
      ...input,
      capability: input.capability ?? input.name ?? '',
      status: input.status ?? 'available',
      data: { ...input.data, level: input.level ?? null },
    });
  }
  setProcedureStatus(
    branchId: string,
    memoryId: string,
    status: 'active' | 'suspended' | 'retired' | 'draft',
    options: { commandId?: string; expectedHead?: number } = {},
  ) {
    return this.memory.setProcedureStatus(branchId, memoryId, status, options);
  }
  async exportStory(storyId: string): Promise<ExportArchive> {
    const epoch = await this.ownerEpoch(),
      story = await this.getStory(storyId),
      branches = await this.listBranches(storyId),
      world = await this.getWorld(story.worldId),
      events: Event[] = [],
      sessions: Session[] = [];
    for (const branch of branches) {
      let after = -1;
      while (true) {
        const page = await this.getEvents(branch.id, {
          asOfSeq: branch.headSeq,
          limit: 1000,
          afterSeq: after,
        });
        events.push(...page);
        if (page.length < 1000) break;
        after = page.at(-1)!.seq;
      }
      sessions.push(...(await this.listSessions(branch.id)));
    }
    const branchIds = JSON.stringify(branches.map((branch) => branch.id));
    const branchRows = (table: string, owned = true) =>
      this.all(
        `SELECT rowid AS rowid,* FROM ${table} WHERE ${owned ? 'owner_id=? AND ' : ''}branch_id IN (SELECT value FROM json_each(?))`,
        ...(owned ? [this.ownerId] : []),
        branchIds,
      );
    const [
      memories,
      sources,
      grants,
      lineage,
      turns,
      scenes,
      resourceBindings,
      memoryHeads,
      capabilities,
      procedureUses,
      memoryCursors,
      memoryApplications,
      observationBatches,
      observationProgress,
      entities,
      entityAliases,
    ] = await Promise.all([
      this.memory.storyHistory(storyId),
      this.all(
        'SELECT * FROM sources WHERE owner_id=? AND world_id=? AND (story_id=? OR story_id IS NULL)',
        this.ownerId,
        world.id,
        story.id,
      ),
      branchRows('knowledge_grants'),
      branchRows('branch_lineage', false),
      branchRows('turns'),
      branchRows('scene_snapshots', false),
      branchRows('resource_bindings'),
      branchRows('memory_heads', false),
      branchRows('capability_versions'),
      branchRows('procedure_uses'),
      branchRows('memory_cursors', false),
      branchRows('memory_event_applications', false),
      branchRows('observation_batches'),
      branchRows('observation_progress', false),
      branchRows('entities'),
      branchRows('entity_aliases'),
    ]);
    const sourceIds = JSON.stringify(sources.map((source) => source.id)),
      memoryIds = JSON.stringify(memories.map((memory) => memory.id)),
      assetIds = JSON.stringify([...new Set(resourceBindings.map((binding) => binding.asset_id))]);
    const [
      sourceSpans,
      memoryDependencies,
      memoryRows,
      assets,
      assetRevisions,
      tombstones,
      sourceDeletionMembers,
    ] = await Promise.all([
      this.all(
        'SELECT * FROM source_spans WHERE source_id IN (SELECT value FROM json_each(?))',
        sourceIds,
      ),
      this.all(
        'SELECT * FROM memory_dependencies WHERE memory_id IN (SELECT value FROM json_each(?))',
        memoryIds,
      ),
      this.all(
        'SELECT rowid AS rowid,* FROM memory_versions WHERE owner_id=? AND story_id=? ORDER BY rowid',
        this.ownerId,
        storyId,
      ),
      this.all(
        'SELECT * FROM assets WHERE owner_id=? AND id IN (SELECT value FROM json_each(?))',
        this.ownerId,
        assetIds,
      ),
      this.all(
        'SELECT r.* FROM asset_revisions r JOIN assets a ON a.id=r.asset_id WHERE a.owner_id=? AND EXISTS(SELECT 1 FROM resource_bindings b WHERE b.branch_id IN (SELECT value FROM json_each(?)) AND b.asset_id=r.asset_id AND b.revision=r.revision)',
        this.ownerId,
        branchIds,
      ),
      this.all(
        "SELECT * FROM deletion_tombstones WHERE owner_id=? AND (branch_id IN (SELECT value FROM json_each(?)) OR kind='source' AND target_id IN (SELECT value FROM json_each(?)))",
        this.ownerId,
        branchIds,
        sourceIds,
      ),
      this.all(
        'SELECT * FROM source_deletion_members WHERE source_id IN (SELECT value FROM json_each(?)) AND memory_id IN (SELECT value FROM json_each(?))',
        sourceIds,
        memoryIds,
      ),
    ]);
    // D1 reads are not a multi-query transaction. Reject an inconsistent archive if
    // source deletion, a turn, a fork or memory projection changed while reading.
    const latest = await this.listBranches(storyId);
    if (
      (await this.ownerEpoch()) !== epoch ||
      stableJson(
        latest
          .map((branch) => [branch.id, branch.headSeq, branch.revision, branch.projectionRevision])
          .sort(),
      ) !==
        stableJson(
          branches
            .map((branch) => [
              branch.id,
              branch.headSeq,
              branch.revision,
              branch.projectionRevision,
            ])
            .sort(),
        )
    )
      throw new StoreError('EXPORT_CHANGED', '故事或来源在导出期间发生变化，请重试');
    return {
      format: 'lightrp-story',
      version: 1,
      exportedAt: now(),
      ownerEpoch: epoch,
      world,
      story,
      branches,
      sessions,
      events: [...new Map(events.map((event) => [event.id, event])).values()],
      sources: sources.map((source) =>
        source.status === 'deleted' ? { ...source, text: null } : source,
      ),
      memories,
      grants,
      lineage,
      turns,
      scenes,
      resourceBindings,
      assets,
      assetRevisions,
      sourceSpans,
      memoryRows,
      memoryHeads,
      memoryDependencies,
      capabilities,
      procedureUses,
      memoryCursors,
      memoryApplications,
      observationBatches,
      observationProgress,
      entities,
      entityAliases,
      tombstones,
      sourceDeletionMembers,
      attachments: [
        ...new Set(
          assetRevisions
            .map((revision) => revision.png_key)
            .filter((key): key is string => typeof key === 'string'),
        ),
      ].map((key) => ({ key, kind: 'character-png', included: false })),
    };
  }
}
