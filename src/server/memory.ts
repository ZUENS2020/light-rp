import type {
  Capability,
  CapabilityInput,
  Evidence,
  ExperienceInput,
  Json,
  KnowledgeInput,
  Memory,
  MemoryOptions,
  MemoryProposal,
  ObservationInput,
  ProcedureUseInput,
  QuerySpec,
  RecallOptions,
  RecallResult,
  SourceFence,
} from '../shared/domain';
import { digest, json, now, stableJson, StoreError, uuid } from './store';
import type { Store } from './store';

type Row = Record<string, unknown>;
/** Space-separated Han unigrams/bigrams plus latin words make unicode61 useful for Chinese. */
export function searchTokens(text: string): string[] {
  const words =
      text
        .toLowerCase()
        .normalize('NFKC')
        .match(/[\p{L}\p{N}_]+/gu) ?? [],
    tokens: string[] = [];
  for (const word of words) {
    const runs = word.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? [];
    for (const run of runs) {
      if (/\p{Script=Han}/u.test(run)) {
        const chars = Array.from(run);
        tokens.push(...chars);
        for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
      } else tokens.push(run);
    }
  }
  return [...new Set(tokens)].slice(0, 4096);
}
export function rrf(lists: string[][], k = 60): Map<string, { score: number; arms: number[] }> {
  const scores = new Map<string, { score: number; arms: number[] }>();
  lists.forEach((list, arm) => {
    [...new Set(list)].forEach((id, i) => {
      const v = scores.get(id) ?? { score: 0, arms: [] };
      v.score += 1 / (k + i + 1);
      v.arms.push(arm);
      scores.set(id, v);
    });
  });
  return scores;
}
export function estimateTokens(text: string) {
  return Math.ceil(
    Array.from(text).reduce(
      (n, c) => n + (/\p{Script=Han}/u.test(c) ? 1 : /[\x00-\x7f]/.test(c) ? 0.28 : 1),
      0,
    ),
  );
}
function memoryRow(r: Row, evidence: Evidence[]): Memory {
  return {
    id: String(r.id),
    memoryKey: String(r.memory_key),
    ownerId: String(r.owner_id),
    storyId: String(r.story_id),
    branchId: String(r.branch_id),
    kind: r.kind as Memory['kind'],
    subject: String(r.subject),
    predicate: String(r.predicate),
    value: json<Json>(r.value_json, null),
    text: String(r.text),
    knownBy: json(r.known_by_json, []),
    observerId: r.observer_id == null ? undefined : String(r.observer_id),
    authority: Number(r.authority),
    confidence: Number(r.confidence),
    validFrom: r.valid_from == null ? null : Number(r.valid_from),
    validTo: r.valid_to == null ? null : Number(r.valid_to),
    originSeq: Number(r.origin_seq),
    recordedSeq: Number(r.recorded_seq),
    recordedAt: String(r.recorded_at),
    revision: Number(r.revision),
    status: r.status as Memory['status'],
    data: json(r.data_json, {}),
    supersedesId: r.supersedes_id == null ? null : String(r.supersedes_id),
    idempotencyKey: String(r.idempotency_key),
    evidence,
    sourceIds: [...new Set(evidence.map((e) => e.sourceId))],
  };
}
interface Prepared {
  id: string;
  key: string;
  specs: QuerySpec[];
  fences: SourceFence[];
  memory: MemoryProposal;
}

export class MemoryEngine {
  constructor(readonly store: Store) {}
  private async sourceInBranch(branchId: string, sourceId: string, asof?: number): Promise<Row> {
    const b = await this.store.getBranch(branchId),
      story = await this.store.getStory(b.storyId),
      s = await this.store.source(sourceId);
    if (s.status !== 'active') throw new StoreError('SOURCE_DELETED', 'Source deleted', 410);
    if (s.world_id !== story.worldId || (s.story_id != null && s.story_id !== story.id))
      throw new StoreError('SOURCE_SCOPE', 'Source belongs to another story', 403);
    if (s.event_id != null) {
      const visible = await this.store.one(
        'SELECT e.id FROM events e JOIN branch_lineage l ON l.ancestor_id=e.branch_id AND l.branch_id=? WHERE e.id=? AND e.owner_id=? AND e.seq<=? AND (l.max_seq IS NULL OR e.seq<=l.max_seq)',
        branchId,
        s.event_id,
        this.store.ownerId,
        asof ?? b.headSeq,
      );
      if (!visible) throw new StoreError('SOURCE_SCOPE', 'Source is outside branch history', 403);
    }
    if (s.asset_id != null) {
      const binding = (await this.store.getResourceBindings(branchId, asof)).find(
        (a) => a.assetId === s.asset_id,
      );
      if (!binding || binding.revision !== Number(s.version))
        throw new StoreError(
          'RESOURCE_REVISION',
          'Source revision is not bound to this branch',
          403,
        );
    }
    return s;
  }
  private async evidence(
    e: Evidence,
    branchId: string,
  ): Promise<{ evidence: Evidence; spec: QuerySpec; fence: SourceFence; source: Row }> {
    const s = await this.sourceInBranch(branchId, e.sourceId),
      chars = Array.from(String(s.text ?? ''));
    if (
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end) ||
      e.start < 0 ||
      e.end <= e.start ||
      e.end > chars.length ||
      chars.slice(e.start, e.end).join('') !== e.quote
    )
      throw new StoreError('EXACT_SOURCE', 'Evidence does not match exact source span', 400);
    if (
      (e.sourceVersion != null && e.sourceVersion !== Number(s.version)) ||
      (e.sourceGeneration != null && e.sourceGeneration !== Number(s.generation))
    )
      throw new StoreError('SOURCE_FENCE', 'Source version changed');
    const existing = await this.store.one<{ id: string }>(
        'SELECT id FROM source_spans WHERE source_id=? AND source_version=? AND source_generation=? AND start_offset=? AND end_offset=?',
        s.id,
        s.version,
        s.generation,
        e.start,
        e.end,
      ),
      // Multiple proposals are prepared before their shared transaction. Use
      // one canonical ID for identical evidence; random IDs let INSERT OR IGNORE
      // discard the second span while its memory_evidence referenced a missing ID.
      id =
        existing?.id ??
        e.spanId ??
        `span_${await digest({ sourceId: e.sourceId, version: Number(s.version), generation: Number(s.generation), start: e.start, end: e.end })}`;
    if (e.spanId && existing && e.spanId !== existing.id)
      throw new StoreError('SPAN_ID', 'Evidence span identity mismatch', 400);
    return {
      evidence: {
        ...e,
        spanId: id,
        sourceVersion: Number(s.version),
        sourceGeneration: Number(s.generation),
      },
      spec: {
        sql: 'INSERT OR IGNORE INTO source_spans(id,source_id,source_version,source_generation,start_offset,end_offset,quote,created_at) VALUES(?,?,?,?,?,?,?,?)',
        params: [id, s.id, s.version, s.generation, e.start, e.end, e.quote, now()],
      },
      fence: {
        sourceId: String(s.id),
        version: Number(s.version),
        generation: Number(s.generation),
      },
      source: s,
    };
  }
  private async latestRows(
    branchId: string,
    options: MemoryOptions = {},
    keys?: string[],
  ): Promise<Row[]> {
    const branch = await this.store.getBranch(branchId),
      asof = Math.min(options.asOfSeq ?? branch.headSeq, branch.headSeq),
      time = options.sceneTime;
    const clauses: string[] = [],
      params: unknown[] = [branchId, this.store.ownerId, asof];
    const selected = keys ? 'AND m.memory_key IN (SELECT value FROM json_each(?))' : '';
    if (keys) params.push(JSON.stringify(keys));
    if (time != null) {
      clauses.push(
        '(m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_to IS NULL OR m.valid_to>?)',
      );
      params.push(time, time);
    }
    const temporal = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    return this.store.all(
      `WITH visible AS (
      SELECT m.*,m.rowid AS version_order,l.depth FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=? WHERE m.owner_id=? AND m.recorded_seq<=? ${selected} AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid)
    ), eligible AS (SELECT m.* FROM visible m WHERE 1=1 ${temporal}), unsuperseded AS (
      SELECT m.* FROM eligible m WHERE NOT EXISTS(SELECT 1 FROM eligible n WHERE n.supersedes_id=m.id OR (n.memory_key=m.memory_key AND n.id<>m.id AND n.recorded_seq>=m.recorded_seq AND json_extract(n.data_json,'$.correction')=1 AND COALESCE(n.valid_from,-1e99)<=COALESCE(m.valid_from,1e99)))
    ), ranked AS (SELECT m.*,ROW_NUMBER() OVER(PARTITION BY memory_key ORDER BY CASE WHEN status IN ('forgotten','invalidated') THEN 1 ELSE 0 END DESC,COALESCE(valid_from,-1e99) DESC,recorded_seq DESC,version_order DESC,depth ASC) AS rank FROM unsuperseded m)
    SELECT * FROM ranked WHERE rank=1 ORDER BY recorded_seq DESC,version_order DESC`,
      ...params,
    );
  }
  private async hydrate(rows: Row[]): Promise<Memory[]> {
    const evidence = new Map<string, Evidence[]>();
    for (let offset = 0; offset < rows.length; offset += 80) {
      const ids = rows.slice(offset, offset + 80).map((r) => r.id);
      if (!ids.length) continue;
      const refs = await this.store.all(
        `SELECT me.memory_id,p.* FROM memory_evidence me JOIN source_spans p ON p.id=me.span_id JOIN memory_versions m ON m.id=me.memory_id WHERE m.owner_id=? AND me.memory_id IN (${ids.map(() => '?').join(',')})`,
        this.store.ownerId,
        ...ids,
      );
      for (const p of refs) {
        const list = evidence.get(String(p.memory_id)) ?? [];
        list.push({
          sourceId: String(p.source_id),
          sourceVersion: Number(p.source_version),
          sourceGeneration: Number(p.source_generation),
          start: Number(p.start_offset),
          end: Number(p.end_offset),
          quote: String(p.quote),
          spanId: String(p.id),
        });
        evidence.set(String(p.memory_id), list);
      }
    }
    return rows.map((r) => memoryRow(r, evidence.get(String(r.id)) ?? []));
  }
  private async liveEvidence(branchId: string, m: Memory, asof?: number): Promise<boolean> {
    if (!m.evidence.length && m.status !== 'forgotten' && m.status !== 'invalidated') return false;
    for (const e of m.evidence) {
      try {
        const s = await this.sourceInBranch(branchId, e.sourceId, asof);
        if (Number(s.version) !== e.sourceVersion || Number(s.generation) !== e.sourceGeneration)
          return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  private async grants(
    branchId: string,
    sourceId: string,
    viewer: string,
    asof?: number,
  ): Promise<Row[]> {
    const b = await this.store.getBranch(branchId);
    return this.store.all(
      `SELECT * FROM (SELECT g.*,p.start_offset,p.end_offset,p.quote,p.source_version,p.source_generation,ROW_NUMBER() OVER(PARTITION BY g.span_id,g.character_id ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC) AS rank FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=? WHERE g.owner_id=? AND g.source_id=? AND g.character_id IN (?,'*') AND g.acquired_seq<=? AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq) AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid)) WHERE rank=1`,
      branchId,
      this.store.ownerId,
      sourceId,
      viewer,
      asof ?? b.headSeq,
    );
  }
  private async spanVisible(branchId: string, e: Evidence, viewer: string, asof?: number) {
    if (viewer === 'director') return true;
    const grants = await this.grants(branchId, e.sourceId, viewer, asof);
    const same = grants.filter(
      (g) =>
        Number(g.source_version) === e.sourceVersion &&
        Number(g.source_generation) === e.sourceGeneration,
    );
    if (
      same.some(
        (g) =>
          g.status === 'revoke' && Number(g.start_offset) < e.end && Number(g.end_offset) > e.start,
      )
    )
      return false;
    return same.some(
      (g) =>
        g.status === 'grant' && Number(g.start_offset) <= e.start && Number(g.end_offset) >= e.end,
    );
  }
  async memories(
    branchId: string,
    options: MemoryOptions = {},
    selectionKey?: string,
  ): Promise<Memory[]> {
    const latest = await this.latestRows(
      branchId,
      options,
      selectionKey != null ? [selectionKey] : undefined,
    );
    return this.authorizedRows(branchId, latest, options, selectionKey, latest);
  }
  /** Keyset pages include ordinary historical changes. Explicit correction and
   * forgetting still block their immutable inputs, as do branch/source/ACL fences. */
  async observationPage(
    branchId: string,
    options: {
      viewer: string;
      through: number;
      after: number;
      limit?: number;
      bucket?: 'rules' | 'facts' | 'interpretations';
    },
  ) {
    const rows = await this.store.all<Row>(
      `SELECT m.*,m.rowid AS version_order FROM memory_versions m
       JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=?
       WHERE m.owner_id=? AND m.recorded_seq<=? AND m.rowid>? AND m.kind<>'observation'
       AND (m.status='active' OR (m.kind='procedure' AND m.status IN ('draft','suspended','retired')))
       ${options.bucket ? `AND CASE WHEN m.authority>=85 THEN 'rules' WHEN m.kind IN ('canon','relation') AND m.authority>=70 THEN 'facts' ELSE 'interpretations' END = ?` : ''}
       AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq)
       AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid)
       ORDER BY m.rowid LIMIT ?`,
      branchId,
      this.store.ownerId,
      options.through,
      options.after,
      ...(options.bucket ? [options.bucket] : []),
      options.limit ?? 24,
    );
    const authorized = new Map(
      (
        await this.authorizedRows(branchId, rows, {
          viewer: options.viewer,
          asOfSeq: options.through,
          includeInactive: true,
        })
      )
        .filter(
          (m) =>
            m.status === 'active' ||
            (m.kind === 'procedure' && ['draft', 'suspended', 'retired'].includes(m.status)),
        )
        .map((m) => [m.id, m]),
    );
    return {
      entries: rows.map((row) => ({
        order: Number(row.version_order),
        memory: authorized.get(String(row.id)) ?? null,
      })),
      after: rows.length ? Number(rows.at(-1)!.version_order) : options.after,
      exhausted: rows.length < (options.limit ?? 24),
    };
  }
  private async observationInputs(
    branchId: string,
    ids: string[],
    through: number,
    viewer = 'director',
  ) {
    if (!ids.length) return [];
    const rows = await this.store.all<Row>(
      `SELECT m.* FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=?
       WHERE m.owner_id=? AND m.id IN (SELECT value FROM json_each(?)) AND m.recorded_seq<=?
       AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq)
       AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid)`,
      branchId,
      this.store.ownerId,
      JSON.stringify(ids),
      through,
    );
    // Preparation may target an older prefix, but a later correction/forgetting
    // in this same branch must still reject its late activation or replay.
    return (
      await this.authorizedRows(branchId, rows, {
        viewer,
        asOfSeq: (await this.store.getBranch(branchId)).headSeq,
        limit: ids.length,
        includeInactive: true,
      })
    ).filter(
      (m) =>
        m.status === 'active' ||
        (m.kind === 'procedure' && ['draft', 'suspended', 'retired'].includes(m.status)),
    );
  }
  private async authorizedRows(
    branchId: string,
    latest: Row[],
    options: MemoryOptions = {},
    selectionKey?: string,
    currentRows?: Row[],
  ): Promise<Memory[]> {
    const branch = await this.store.getBranch(branchId),
      story = await this.store.getStory(branch.storyId),
      asof = Math.min(options.asOfSeq ?? branch.headSeq, branch.headSeq),
      viewer = options.viewer ?? 'director',
      result: Memory[] = [];
    if (!latest.length) return result;
    // A compressed observation can cite an older immutable observation. Only explicit
    // correction/forgetting, source loss, or an unavailable branch prefix invalidates it.
    const dependencyRows = await this.store.all(
      `WITH RECURSIVE visible AS (
      SELECT m.* FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=? WHERE m.owner_id=? AND m.recorded_seq<=? AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid)
    ), needed(id) AS (SELECT value FROM json_each(?) UNION SELECT d.depends_on_id FROM memory_dependencies d JOIN needed n ON d.memory_id=n.id), blocked(id) AS (
      SELECT supersedes_id FROM visible WHERE supersedes_id IS NOT NULL AND (status IN ('forgotten','invalidated') OR json_extract(data_json,'$.correction')=1)
      UNION SELECT v.supersedes_id FROM visible v JOIN blocked b ON b.id=v.id WHERE v.supersedes_id IS NOT NULL
    ) SELECT v.*,EXISTS(SELECT 1 FROM blocked b WHERE b.id=v.id) AS blocked FROM visible v JOIN needed n ON n.id=v.id`,
      branchId,
      this.store.ownerId,
      asof,
      JSON.stringify(latest.map((m) => m.id)),
    );
    const hydrated = await this.hydrate(dependencyRows),
      byId = new Map(hydrated.map((m) => [m.id, m])),
      latestIds = new Set(latest.map((m) => String(m.id))),
      blocked = new Set(dependencyRows.filter((r) => Number(r.blocked)).map((r) => String(r.id)));
    const capabilityKeys = [
      ...new Set(
        hydrated.filter((m) => m.data?.recordType === 'capability').map((m) => m.memoryKey),
      ),
    ].filter((key) => !currentRows?.some((row) => row.memory_key === key));
    const latestByKey = new Map(
      [
        ...(currentRows ?? []),
        ...(capabilityKeys.length ? await this.latestRows(branchId, options, capabilityKeys) : []),
      ].map((m) => [String(m.memory_key), m]),
    );
    const deps = await this.store.all<{ memory_id: string; depends_on_id: string }>(
        'SELECT memory_id,depends_on_id FROM memory_dependencies WHERE memory_id IN (SELECT value FROM json_each(?))',
        JSON.stringify([...byId.keys()]),
      ),
      dependencies = new Map<string, string[]>();
    for (const d of deps) {
      const ids = dependencies.get(d.memory_id) ?? [];
      ids.push(d.depends_on_id);
      dependencies.set(d.memory_id, ids);
    }
    const sourceIds = [...new Set(hydrated.flatMap((m) => m.sourceIds))],
      sources = new Map(
        (
          await this.store.all(
            `SELECT s.id,s.status,s.version,s.generation,s.world_id,s.story_id,s.asset_id,s.event_id,e.seq,l.depth,l.max_seq FROM sources s LEFT JOIN events e ON e.id=s.event_id LEFT JOIN branch_lineage l ON l.ancestor_id=e.branch_id AND l.branch_id=? WHERE s.owner_id=? AND s.id IN (SELECT value FROM json_each(?))`,
            branchId,
            this.store.ownerId,
            JSON.stringify(sourceIds),
          )
        ).map((r) => [String(r.id), r]),
      );
    const bindings = new Map(
        (await this.store.getResourceBindings(branchId, asof)).map((b) => [b.assetId, b.revision]),
      ),
      suppressed = await this.store.forgottenSpans(branchId, asof);
    const isLive = (m: Memory) => {
      if (!m.evidence.length) return ['forgotten', 'invalidated'].includes(m.status);
      if (
        m.evidence.some((e) =>
          suppressed.some((p) => p.sourceId === e.sourceId && p.start < e.end && p.end > e.start),
        )
      )
        return false;
      return m.evidence.every((e) => {
        const s = sources.get(e.sourceId);
        return (
          !!s &&
          s.status === 'active' &&
          s.world_id === story.worldId &&
          (s.story_id == null || s.story_id === story.id) &&
          Number(s.version) === e.sourceVersion &&
          Number(s.generation) === e.sourceGeneration &&
          (s.event_id == null ||
            (s.depth != null &&
              Number(s.seq) <= asof &&
              (s.max_seq == null || Number(s.seq) <= Number(s.max_seq)))) &&
          (s.asset_id == null || bindings.get(String(s.asset_id)) === Number(s.version))
        );
      });
    };
    const valid = new Map<string, boolean>(),
      visiting = new Set<string>();
    const dependencyValid = (id: string): boolean => {
      if (valid.has(id)) return valid.get(id)!;
      const m = byId.get(id);
      if (
        !m ||
        blocked.has(id) ||
        ['forgotten', 'invalidated'].includes(m.status) ||
        !isLive(m) ||
        visiting.has(id)
      ) {
        valid.set(id, false);
        return false;
      }
      const current = latestByKey.get(m.memoryKey);
      if (
        m.data?.recordType === 'capability' &&
        (!current || json<Json>(current.value_json, null) !== 'available')
      ) {
        valid.set(id, false);
        return false;
      }
      visiting.add(id);
      const okay = (dependencies.get(id) ?? []).every(dependencyValid);
      visiting.delete(id);
      valid.set(id, okay);
      return okay;
    };
    // Batch the source ACL read: the authorization ledger, not a stale knownBy hint,
    // controls characters who acquire or lose knowledge after a fact was extracted.
    const grants = await this.store.all(
      `SELECT * FROM (SELECT g.*,p.start_offset,p.end_offset,p.source_version,p.source_generation,ROW_NUMBER() OVER(PARTITION BY g.span_id,g.character_id ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC) AS rank FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=? WHERE g.owner_id=? AND g.source_id IN (SELECT value FROM json_each(?)) AND g.acquired_seq<=? AND g.recorded_seq<=? AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq) AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid) ${viewer === 'director' ? '' : "AND g.character_id IN (?,'*')"}) WHERE rank=1`,
      branchId,
      this.store.ownerId,
      JSON.stringify(sourceIds),
      asof,
      asof,
      ...(viewer === 'director' ? [] : [viewer]),
    );
    const grantsBySource = new Map<string, Row[]>();
    for (const g of grants) {
      const list = grantsBySource.get(String(g.source_id)) ?? [];
      list.push(g);
      grantsBySource.set(String(g.source_id), list);
    }
    const visibleSpan = (e: Evidence, actor: string) => {
      const same = (grantsBySource.get(e.sourceId) ?? []).filter(
        (g) =>
          (g.character_id === actor || g.character_id === '*') &&
          Number(g.source_version) === e.sourceVersion &&
          Number(g.source_generation) === e.sourceGeneration,
      );
      return (
        !same.some(
          (g) =>
            g.status === 'revoke' &&
            Number(g.start_offset) < e.end &&
            Number(g.end_offset) > e.start,
        ) &&
        same.some(
          (g) =>
            g.status === 'grant' &&
            Number(g.start_offset) <= e.start &&
            Number(g.end_offset) >= e.end,
        )
      );
    };
    const recipients = [...new Set(grants.map((g) => String(g.character_id)))];
    const aclCache = new Map<string, boolean>();
    const authorized = (id: string, actor: string): boolean => {
      if (actor === 'director') return true;
      const key = `${actor}:${id}`;
      if (aclCache.has(key)) return aclCache.get(key)!;
      const m = byId.get(id);
      // Mark before recursion: malformed cycles must fail closed.
      aclCache.set(key, false);
      const okay =
        !!m &&
        (m.kind !== 'belief' || m.observerId === actor) &&
        m.evidence.every((e) => visibleSpan(e, actor)) &&
        (dependencies.get(id) ?? []).every((dep) => authorized(dep, actor));
      aclCache.set(key, okay);
      return okay;
    };
    const allSourceIds = (id: string, seen = new Set<string>()): string[] => {
      if (seen.has(id)) return [];
      seen.add(id);
      return [
        ...new Set([
          ...(byId.get(id)?.sourceIds ?? []),
          ...(dependencies.get(id) ?? []).flatMap((dep) => allSourceIds(dep, seen)),
        ]),
      ];
    };
    for (const r of latest) {
      const m = byId.get(String(r.id))!;
      if (!m) continue;
      if (selectionKey != null && m.memoryKey !== selectionKey) continue;
      if (!options.includeInactive && m.status !== 'active') continue;
      if (options.kinds && !options.kinds.includes(m.kind)) continue;
      if (
        blocked.has(m.id) ||
        !isLive(m) ||
        (dependencies.get(m.id) ?? []).some((id) => !dependencyValid(id))
      )
        continue;
      if (!authorized(m.id, viewer)) continue;
      m.knownBy = recipients.filter((actor) => m.evidence.length > 0 && authorized(m.id, actor));
      m.sourceIds = allSourceIds(m.id);
      if (latestIds.has(m.id)) result.push(m);
      if (result.length >= (options.limit ?? 1000)) break;
    }
    return result;
  }
  private sourceAuthority(source: Row, role: string | undefined, speaker: unknown) {
    if (source.kind === 'worldbook') return 90;
    if (['character', 'character_card'].includes(String(source.kind))) return 85;
    if (role === 'correction') return 100;
    if (role === 'assistant' && speaker == null) return 70;
    return 35;
  }
  private async prepare(
    branchId: string,
    p: MemoryProposal,
    forceSupersedes?: string,
  ): Promise<Prepared> {
    const branch = await this.store.getBranch(branchId);
    if (
      !p.text.trim() ||
      p.text.length > 30000 ||
      !p.subject ||
      !p.predicate ||
      !p.evidence.length ||
      p.evidence.length > 128
    )
      throw new StoreError('MEMORY_INPUT', 'Memory needs text, entities, and exact evidence', 400);
    const prepared = [];
    for (const e of p.evidence) prepared.push(await this.evidence(e, branchId));
    const sourceIds = [...new Set(prepared.map((e) => e.fence.sourceId))].sort(),
      eventRows: Row[] = [];
    for (const sourceId of sourceIds) {
      const e = await this.store.one(
        'SELECT e.role,e.speaker_id,e.seq FROM events e JOIN sources s ON s.event_id=e.id WHERE s.id=? AND e.owner_id=?',
        sourceId,
        this.store.ownerId,
      );
      if (e) eventRows.push({ ...e, sourceId });
    }
    const evidenceOrigin = Math.max(0, ...eventRows.map((e) => Number(e.seq))),
      // Observations describe a verified prefix, including events with no facts.
      // Their visible version must be dated at that prefix, not at an anchor quote.
      origin =
        p.kind === 'observation' ? Math.max(evidenceOrigin, p.originSeq ?? 0) : evidenceOrigin,
      kind = p.kind;
    if (origin > branch.headSeq)
      throw new StoreError('MEMORY_FUTURE', 'Memory origin is beyond branch head', 400);
    if (kind === 'belief' && !p.observerId)
      throw new StoreError('BELIEF_OBSERVER', 'Belief needs an observer', 400);
    const authority = Math.min(
      ...prepared.map((e) => {
        const event = eventRows.find((v) => v.sourceId === e.fence.sourceId);
        return this.sourceAuthority(e.source, event?.role as string | undefined, event?.speaker_id);
      }),
    );
    const confidence = authority >= 90 ? 0.98 : authority >= 70 ? 0.85 : 0.55;
    let key =
      p.memoryKey ??
      `${kind}:${p.subject}:${p.predicate}:${p.observerId ?? ''}${['episode', 'experience'].includes(kind) ? ':' + sourceIds.join(':') : kind === 'relation' ? ':' + stableJson(p.value) : ''}`;
    // UI listing limits must never determine the version being updated.
    const current = (await this.memories(branchId, { includeInactive: true }, key))[0];
    if (current?.status === 'forgotten' && origin <= current.recordedSeq)
      throw new StoreError('FORGOTTEN_REPLAY', 'Forgotten source cannot recreate the same memory');
    const suppressed = await this.store.forgottenSpans(branchId);
    if (
      prepared.some((e) =>
        suppressed.some(
          (p) =>
            p.sourceId === e.evidence.sourceId &&
            p.start < e.evidence.end &&
            p.end > e.evidence.start,
        ),
      )
    )
      throw new StoreError(
        'FORGOTTEN_SOURCE',
        'Forgotten evidence cannot be reused under a different fact or observation',
      );
    if (current?.data?.correction && origin < (current.originSeq ?? 0) && !forceSupersedes)
      throw new StoreError(
        'CORRECTED_REPLAY',
        'Older extraction cannot overwrite an author correction',
      );
    const validFrom =
        p.validFrom ?? (prepared.every((e) => e.source.event_id == null) ? null : origin),
      validTo = p.validTo ?? null;
    let status = p.status ?? 'active',
      supersedes = forceSupersedes ?? null;
    if (
      current &&
      kind === 'canon' &&
      current.authority! > authority &&
      current.value !== p.value &&
      stableJson(current.value) !== stableJson(p.value) &&
      (validFrom ?? -Infinity) <= (current.validFrom ?? -Infinity) &&
      !forceSupersedes
    ) {
      key += `:candidate:${sourceIds.join(':')}`;
      status = 'draft';
    } else if (
      current &&
      (forceSupersedes || (validFrom ?? -Infinity) >= (current.validFrom ?? -Infinity))
    ) {
      supersedes = current.id;
    }
    const id = p.id ?? uuid(),
      idempotency =
        p.idempotencyKey ??
        (await digest({
          kind,
          key,
          text: p.text,
          value: p.value,
          data: p.data ?? {},
          evidence: prepared
            .map(({ evidence }) => ({
              sourceId: evidence.sourceId,
              version: evidence.sourceVersion,
              generation: evidence.sourceGeneration,
              start: evidence.start,
              end: evidence.end,
              quote: evidence.quote,
            }))
            .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
          origin,
          validFrom,
          validTo,
          status,
        })),
      revision = (current?.revision ?? 0) + 1;
    const knownBy: string[] = [];
    for (const viewer of [...new Set(p.knownBy ?? [])]) {
      if (kind === 'belief' && viewer !== p.observerId) continue;
      let visible = true;
      for (const e of prepared)
        if (!(await this.spanVisible(branchId, e.evidence, viewer))) {
          visible = false;
          break;
        }
      if (visible) knownBy.push(viewer);
    }
    const normalized: MemoryProposal = {
      ...p,
      id,
      memoryKey: key,
      authority: kind === 'observation' ? Math.min(authority, 20) : authority,
      confidence: kind === 'observation' ? Math.min(confidence, 0.5) : confidence,
      validFrom,
      validTo,
      originSeq: origin,
      status,
      knownBy,
      evidence: prepared.map((e) => e.evidence),
    };
    const specs: QuerySpec[] = [
      ...prepared.map((e) => e.spec),
      {
        sql: 'INSERT INTO memory_versions(id,owner_id,story_id,branch_id,memory_key,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          this.store.ownerId,
          branch.storyId,
          branchId,
          key,
          kind,
          p.subject,
          p.predicate,
          stableJson(p.value),
          p.text,
          searchTokens(`${p.subject} ${p.predicate} ${p.text}`).join(' '),
          JSON.stringify(knownBy),
          p.observerId ?? null,
          normalized.authority,
          normalized.confidence,
          validFrom,
          validTo,
          origin,
          origin,
          now(),
          revision,
          supersedes,
          status,
          JSON.stringify(p.data ?? {}),
          idempotency,
        ],
      },
      ...prepared.map((e) => ({
        sql: 'INSERT INTO memory_evidence(memory_id,span_id) VALUES(?,?)',
        params: [id, e.evidence.spanId],
      })),
      this.store.memoryHeadSpec(branchId, key),
    ];
    return {
      id,
      key,
      specs,
      fences: [...prepared.map((e) => e.fence), ...(p.sourceFence ?? [])],
      memory: normalized,
    };
  }
  private async byId(branchId: string, id: string) {
    const rows = await this.latestRows(branchId),
      r = rows.find((r) => r.id === id);
    if (!r)
      throw new StoreError(
        'MEMORY_NOT_CURRENT',
        'Memory version is not current in this branch',
        404,
      );
    const m = (await this.hydrate([r]))[0];
    if (!(await this.liveEvidence(branchId, m)))
      throw new StoreError('SOURCE_DELETED', 'Memory source no longer available', 410);
    return m;
  }
  private async byRevision(branchId: string, id: string) {
    const b = await this.store.getBranch(branchId),
      r = await this.store.one(
        `SELECT m.* FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=? WHERE m.id=? AND m.owner_id=? AND m.recorded_seq<=? AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid)`,
        branchId,
        id,
        this.store.ownerId,
        b.headSeq,
      );
    if (!r)
      throw new StoreError(
        'MEMORY_REVISION_SCOPE',
        'Memory revision is outside branch history',
        404,
      );
    const m = (await this.hydrate([r]))[0];
    if (!(await this.liveEvidence(branchId, m)))
      throw new StoreError('SOURCE_DELETED', 'Memory source no longer available', 410);
    return m;
  }
  async versions(branchId: string, id: string): Promise<Memory[]> {
    const branch = await this.store.getBranch(branchId),
      visible = `SELECT m.* FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=? WHERE m.owner_id=? AND m.recorded_seq<=? AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid)`;
    const anchor = await this.store.one(
      `SELECT memory_key FROM (${visible}) WHERE id=?`,
      branchId,
      this.store.ownerId,
      branch.headSeq,
      id,
    );
    if (!anchor)
      throw new StoreError(
        'MEMORY_REVISION_SCOPE',
        'Memory revision is outside branch history',
        404,
      );
    const rows = await this.store.all(
      `SELECT * FROM (${visible}) WHERE memory_key=? ORDER BY recorded_seq,revision`,
      branchId,
      this.store.ownerId,
      branch.headSeq,
      anchor.memory_key,
    );
    // This owner-only audit endpoint reads immutable history, including forgotten
    // revisions. Source deletion has already scrubbed the underlying bodies.
    return this.hydrate(rows);
  }
  async storyHistory(storyId: string): Promise<Memory[]> {
    await this.store.getStory(storyId);
    return this.hydrate(
      await this.store.all(
        'SELECT * FROM memory_versions WHERE owner_id=? AND story_id=? ORDER BY recorded_seq,rowid',
        this.store.ownerId,
        storyId,
      ),
    );
  }
  async propose(branchId: string, p: MemoryProposal): Promise<Memory> {
    const epoch = p.ownerEpoch ?? (await this.store.ownerEpoch());
    if (epoch !== (await this.store.ownerEpoch()))
      throw new StoreError('STALE_WRITE', 'State changed; refresh and retry.');
    const branch = await this.store.getBranch(branchId),
      prepared = await this.prepare(branchId, p),
      idempotency = prepared.specs
        .find((s) => s.sql.startsWith('INSERT INTO memory_versions'))!
        .params!.at(-1);
    const existing = await this.store.one(
      'SELECT * FROM memory_versions WHERE owner_id=? AND branch_id=? AND idempotency_key=?',
      this.store.ownerId,
      branchId,
      idempotency,
    );
    if (existing) return (await this.hydrate([existing]))[0];
    await this.store.batch([
      this.store.epochGuard(epoch),
      ...this.store.sourceGuards(prepared.fences),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [branchId, this.store.ownerId, branch.projectionRevision],
      ),
      ...prepared.specs,
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [branchId, this.store.ownerId],
      },
      this.store.cleanupGuards(),
    ]);
    return (
      await this.hydrate([
        (await this.store.one(
          'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
          prepared.id,
          this.store.ownerId,
        ))!,
      ])
    )[0];
  }
  async extract(
    branchId: string,
    input: {
      eventIds?: string[];
      proposals: MemoryProposal[];
      cursor?: number;
      sourceFence?: SourceFence[];
      ownerEpoch?: number;
      extractorVersion?: string;
    },
    projectionAttempt = 0,
  ): Promise<{ accepted: string[]; cursor: number }> {
    const branch = await this.store.getBranch(branchId),
      epoch = input.ownerEpoch ?? (await this.store.ownerEpoch()),
      cursor = input.cursor ?? branch.headSeq;
    if (cursor > branch.headSeq)
      throw new StoreError('CURSOR_FUTURE', 'Cursor ahead of branch', 400);
    const suppressed = await this.store.forgottenSpans(branchId),
      prepared: Prepared[] = [];
    for (const p of input.proposals) {
      if (
        p.evidence.some((e) =>
          suppressed.some((s) => s.sourceId === e.sourceId && s.start < e.end && s.end > e.start),
        )
      )
        continue;
      const q = await this.prepare(branchId, p);
      const idem = q.specs
        .find((s) => s.sql.startsWith('INSERT INTO memory_versions'))!
        .params!.at(-1);
      if (
        !(await this.store.one(
          'SELECT id FROM memory_versions WHERE owner_id=? AND branch_id=? AND idempotency_key=?',
          this.store.ownerId,
          branchId,
          idem,
        ))
      )
        prepared.push(q);
    }
    const version = input.extractorVersion ?? 'v1',
      eventIds = input.eventIds ?? [],
      applications: QuerySpec[] = [];
    for (const eventId of eventIds)
      applications.push({
        sql: 'INSERT OR IGNORE INTO memory_event_applications(branch_id,event_id,event_seq,extractor_version,created_at) SELECT ?,e.id,e.seq,?,? FROM events e JOIN branch_lineage l ON l.ancestor_id=e.branch_id AND l.branch_id=? WHERE e.id=? AND e.owner_id=? AND e.seq<=? AND (l.max_seq IS NULL OR e.seq<=l.max_seq)',
        params: [branchId, version, now(), branchId, eventId, this.store.ownerId, cursor],
      });
    if (!input.eventIds) {
      for (const p of prepared)
        for (const f of p.fences)
          applications.push({
            sql: 'INSERT OR IGNORE INTO memory_event_applications(branch_id,event_id,event_seq,extractor_version,created_at) SELECT ?,e.id,e.seq,?,? FROM events e WHERE e.source_id=? AND e.owner_id=? AND e.seq<=?',
            params: [branchId, version, now(), f.sourceId, this.store.ownerId, cursor],
          });
    }
    try {
      await this.store.batch([
        this.store.epochGuard(epoch),
        ...this.store.sourceGuards([
          ...(input.sourceFence ?? []),
          ...prepared.flatMap((p) => p.fences),
        ]),
        this.store.guard(
          'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
          [branchId, this.store.ownerId, branch.projectionRevision],
        ),
        ...prepared.flatMap((p) => p.specs),
        ...applications,
        {
          sql: `INSERT INTO memory_cursors(branch_id,extractor_version,applied_seq,updated_at) SELECT ?,?,COALESCE((SELECT MIN(e.seq)-1 FROM events e JOIN sources s ON s.id=e.source_id JOIN branch_lineage l ON l.ancestor_id=e.branch_id AND l.branch_id=? WHERE e.owner_id=? AND e.seq<=? AND s.status='active' AND (l.max_seq IS NULL OR e.seq<=l.max_seq) AND NOT EXISTS(SELECT 1 FROM memory_event_applications a WHERE a.branch_id=? AND a.event_id=e.id AND a.extractor_version=?)),?),? ON CONFLICT(branch_id,extractor_version) DO UPDATE SET applied_seq=MAX(applied_seq,excluded.applied_seq),updated_at=excluded.updated_at`,
          params: [
            branchId,
            version,
            branchId,
            this.store.ownerId,
            cursor,
            branchId,
            version,
            cursor,
            now(),
          ],
        },
        {
          sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
          params: [branchId, this.store.ownerId],
        },
        this.store.cleanupGuards(),
      ]);
    } catch (error) {
      // All failed batch writes have rolled back. Reprepare only when an
      // independent projection moved; the fixed epoch and original source
      // fences remain required on every attempt. Deleted/corrected evidence
      // still fails its source checks rather than acquiring a new fence.
      if (
        error instanceof StoreError &&
        error.code === 'STALE_WRITE' &&
        projectionAttempt < 2 &&
        (await this.store.ownerEpoch()) === epoch &&
        (await this.store.getBranch(branchId)).projectionRevision !== branch.projectionRevision
      )
        return this.extract(
          branchId,
          { ...input, ownerEpoch: epoch, cursor },
          projectionAttempt + 1,
        );
      throw error;
    }
    const result = await this.store.one<{ applied_seq: number }>(
      'SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version=?',
      branchId,
      version,
    );
    return { accepted: prepared.map((p) => p.id), cursor: result!.applied_seq };
  }
  async activateObservation(input: ObservationInput) {
    const batchId = await digest({
        ownerId: this.store.ownerId,
        branchId: input.branchId,
        cursor: input.cursor,
        version: input.extractorVersion ?? 'observations-v1',
        inputs: [...input.expectedMemoryIds].sort(),
        progress: input.progress ?? null,
        proposals: input.proposals.map(
          ({ id: _id, ownerEpoch: _epoch, sourceFence: _fence, ...p }) => p,
        ),
      }),
      existingBatch = await this.store.one(
        'SELECT input_json,status FROM observation_batches WHERE id=? AND owner_id=? AND branch_id=?',
        batchId,
        this.store.ownerId,
        input.branchId,
      );
    const branch = await this.store.getBranch(input.branchId),
      epoch = input.ownerEpoch ?? (await this.store.ownerEpoch()),
      historical = new Set(input.historicalMemoryIds ?? []),
      current = await this.observationInputs(input.branchId, input.expectedMemoryIds, input.cursor),
      ids = new Set(current.map((m) => m.id));
    if (!Number.isInteger(input.cursor) || input.cursor < 0 || input.cursor > branch.headSeq)
      throw new StoreError('CURSOR_FUTURE', 'Observation cursor is outside branch history', 400);
    if (input.expectedMemoryIds.some((id) => !ids.has(id)))
      throw new StoreError(
        'OBSERVATION_STALE',
        'Observation inputs were corrected, forgotten or deleted',
      );
    if (input.progress) {
      const viewer = String(input.progress.state.viewer ?? 'director');
      const authorized = await this.observationInputs(
        input.branchId,
        input.expectedMemoryIds,
        input.cursor,
        viewer,
      );
      if (authorized.length !== input.expectedMemoryIds.length)
        throw new StoreError('OBSERVATION_STALE', 'Observation knowledge grants changed');
    }
    if (existingBatch?.status === 'active') {
      const previous = json<{ accepted?: string[] }>(existingBatch.input_json, {});
      return { batchId, accepted: previous.accepted ?? [], cursor: input.cursor, replayed: true };
    }
    if (input.proposals.some((p) => p.kind !== 'observation'))
      throw new StoreError('OBSERVATION_KIND', 'Observation batch contains another kind', 400);
    const prepared: Prepared[] = [],
      accepted: string[] = [];
    for (const p of input.proposals) {
      const q = await this.prepare(input.branchId, p),
        idem = q.specs.find((s) => s.sql.startsWith('INSERT INTO memory_versions'))!.params!.at(-1),
        existing = await this.store.one<{ id: string }>(
          'SELECT id FROM memory_versions WHERE owner_id=? AND branch_id=? AND idempotency_key=?',
          this.store.ownerId,
          input.branchId,
          idem,
        );
      accepted.push(existing?.id ?? q.id);
      if (!existing) prepared.push(q);
    }
    const dependencyFences: QuerySpec[] = input.expectedMemoryIds.map((id) =>
      historical.has(id)
        ? this.store.guard(
            `EXISTS(SELECT 1 FROM memory_versions m JOIN branch_lineage l ON l.ancestor_id=m.branch_id AND l.branch_id=? WHERE m.id=? AND m.owner_id=? AND (m.status='active' OR (m.kind='procedure' AND m.status IN ('draft','suspended','retired'))) AND m.recorded_seq<=? AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid))`,
            [input.branchId, id, this.store.ownerId, input.cursor],
          )
        : this.store.guard('EXISTS(SELECT 1 FROM memory_heads WHERE branch_id=? AND memory_id=?)', [
            input.branchId,
            id,
          ]),
    );
    await this.store.batch([
      this.store.epochGuard(epoch),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [
          input.branchId,
          this.store.ownerId,
          input.expectedProjectionRevision ?? branch.projectionRevision,
        ],
      ),
      ...(input.progress
        ? [
            this.store.guard(
              'COALESCE((SELECT revision FROM observation_progress WHERE branch_id=? AND scope=?),0)=?',
              [input.branchId, input.progress.scope, input.progress.expectedRevision],
            ),
          ]
        : []),
      ...dependencyFences,
      ...this.store.sourceGuards([
        ...(input.sourceFence ?? []),
        ...prepared.flatMap((p) => p.fences),
      ]),
      {
        sql: 'INSERT INTO observation_batches(id,owner_id,branch_id,cursor,owner_epoch,status,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [
          batchId,
          this.store.ownerId,
          input.branchId,
          input.cursor,
          epoch,
          'active',
          JSON.stringify({ expectedMemoryIds: input.expectedMemoryIds, accepted }),
          now(),
          now(),
        ],
      },
      ...prepared.flatMap((p) => p.specs),
      ...accepted.flatMap((id) =>
        input.expectedMemoryIds
          .filter((dep) => dep !== id)
          .map((dep) => ({
            sql: 'INSERT OR IGNORE INTO memory_dependencies(memory_id,depends_on_id) VALUES(?,?)',
            params: [id, dep],
          })),
      ),
      ...(input.progress
        ? [
            {
              sql: 'INSERT INTO observation_progress(branch_id,scope,observation_id,revision,state_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(branch_id,scope) DO UPDATE SET observation_id=excluded.observation_id,revision=excluded.revision,state_json=excluded.state_json,updated_at=excluded.updated_at',
              params: [
                input.branchId,
                input.progress.scope,
                accepted.at(-1) ?? input.progress.state.observationId ?? null,
                input.progress.expectedRevision + 1,
                JSON.stringify(input.progress.state),
                now(),
              ],
            },
          ]
        : []),
      {
        sql: `INSERT INTO memory_cursors(branch_id,extractor_version,applied_seq,updated_at) VALUES(?,?,?,?) ON CONFLICT(branch_id,extractor_version) DO UPDATE SET applied_seq=${input.progress ? 'excluded.applied_seq' : 'MAX(applied_seq,excluded.applied_seq)'},updated_at=excluded.updated_at`,
        params: [
          input.branchId,
          input.extractorVersion ?? 'observations-v1',
          input.progress ? Number(input.progress.state.throughSeq ?? 0) : input.cursor,
          now(),
        ],
      },
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [input.branchId, this.store.ownerId],
      },
      this.store.cleanupGuards(),
    ]);
    return { batchId, accepted, cursor: input.cursor, replayed: false };
  }
  async correct(
    branchId: string,
    memoryId: string,
    input: { text: string; value: Json; evidence: Evidence[]; validFrom?: number },
  ) {
    const current = await this.byId(branchId, memoryId),
      epoch = await this.store.ownerEpoch(),
      branch = await this.store.getBranch(branchId),
      p = await this.prepare(
        branchId,
        {
          ...current,
          id: undefined,
          idempotencyKey: uuid(),
          text: input.text,
          value: input.value,
          evidence: input.evidence,
          validFrom: input.validFrom ?? current.validFrom,
          status: 'active',
          data: { ...current.data, correction: true },
        },
        memoryId,
      );
    await this.store.batch([
      this.store.epochGuard(epoch),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [branchId, this.store.ownerId, branch.projectionRevision],
      ),
      ...this.store.sourceGuards(p.fences),
      ...p.specs,
      {
        sql: 'UPDATE owners SET deletion_epoch=deletion_epoch+1 WHERE owner_id=?',
        params: [this.store.ownerId],
      },
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [branchId, this.store.ownerId],
      },
      ...(await this.invalidateDependents(branchId, memoryId, 'corrected')),
      this.indexOutbox(branchId, [memoryId, p.id]),
      this.store.cleanupGuards(),
    ]);
    return (
      await this.hydrate([
        (await this.store.one('SELECT * FROM memory_versions WHERE id=?', p.id))!,
      ])
    )[0];
  }
  /** The author source, corrected revision, dependent invalidations and outbox commit once. */
  async authorCorrection(input: {
    branchId: string;
    sessionId?: string;
    commandId: string;
    expectedHead?: number;
    memoryId?: string;
    subjectId?: string;
    predicate?: string;
    text: string;
    value?: Json;
  }): Promise<Memory> {
    const { branchId, commandId } = input,
      text = input.text.trim(),
      value = input.value === undefined ? text : input.value;
    if (!text || text.length > 20000 || commandId.length < 8 || commandId.length > 200)
      throw new StoreError('CORRECTION_INPUT', '作者纠正需要有效正文和幂等键', 400);
    const fingerprint = {
      kind: 'author-correction',
      memoryId: input.memoryId ?? null,
      subjectId: input.subjectId ?? null,
      predicate: input.predicate ?? null,
      text,
      value,
    };
    const id = `correction_${await digest({ ownerId: this.store.ownerId, branchId, commandId })}`;
    const previous = await this.store.one<{ session_id: string }>(
      'SELECT session_id FROM turns WHERE owner_id=? AND branch_id=? AND request_id=?',
      this.store.ownerId,
      branchId,
      commandId,
    );
    const branch = await this.store.getBranch(branchId),
      sessionId =
        previous?.session_id ?? input.sessionId ?? (await this.store.listSessions(branchId))[0]?.id;
    if (!sessionId) throw new StoreError('SESSION_SCOPE', '作者纠正需要当前故事的聊天', 400);
    const messages = [{ role: 'correction' as const, text, knownBy: [] }];
    if (previous) {
      await this.store.appendTurn(
        { branchId, sessionId, requestId: commandId, messages },
        {
          fingerprint,
          prepare: async () => {
            throw new StoreError('CORRECTION_REPLAY', '已提交纠正缺少对应投影');
          },
        },
      );
      const row = await this.store.one(
        'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
        id,
        this.store.ownerId,
      );
      if (!row) throw new StoreError('CORRECTION_REPLAY', '已提交纠正缺少对应投影', 500);
      return (await this.hydrate([row]))[0];
    }
    const epoch = await this.store.ownerEpoch();
    let current: Memory | undefined;
    if (input.memoryId) current = await this.byId(branchId, input.memoryId);
    else if (input.subjectId && input.predicate) {
      const matches = (await this.latestRows(branchId)).filter(
        (memory) => memory.subject === input.subjectId && memory.predicate === input.predicate,
      );
      if (matches.length > 1)
        throw new StoreError(
          'CORRECTION_AMBIGUOUS',
          '存在多个关系或认知版本，请指定 memoryId',
          422,
        );
      if (matches[0]) current = await this.byId(branchId, String(matches[0].id));
    }
    if (current && current.status !== 'active')
      throw new StoreError('MEMORY_NOT_CURRENT', '只能纠正当前有效记忆', 409);
    const fences: SourceFence[] = [];
    for (const proof of current?.evidence ?? []) {
      const source = await this.store.source(proof.sourceId);
      fences.push({
        sourceId: proof.sourceId,
        version: Number(source.version),
        generation: Number(source.generation),
      });
    }
    const key =
        current?.memoryKey ??
        `canon:${input.subjectId ?? 'author'}:${input.predicate ?? `rule:${commandId}`}:`,
      subject = current?.subject ?? input.subjectId ?? 'author',
      predicate = current?.predicate ?? input.predicate ?? `rule:${commandId}`,
      kind = current?.kind ?? 'canon';
    await this.store.appendTurn(
      {
        branchId,
        sessionId,
        requestId: commandId,
        expectedHead: input.expectedHead ?? branch.headSeq,
        expectedProjectionRevision: branch.projectionRevision,
        ownerEpoch: epoch,
        sourceFence: fences,
        messages,
      },
      {
        fingerprint,
        advanceOwnerEpoch: true,
        prepare: async (events, at) => {
          const source = events[0]!,
            spanId = uuid(),
            seq = source.seq;
          return [
            {
              sql: 'INSERT INTO source_spans(id,source_id,source_version,source_generation,start_offset,end_offset,quote,created_at) VALUES(?,?,1,0,0,?,?,?)',
              params: [spanId, source.sourceId, Array.from(text).length, text, at],
            },
            {
              sql: 'INSERT INTO memory_versions(id,owner_id,story_id,branch_id,memory_key,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              params: [
                id,
                this.store.ownerId,
                branch.storyId,
                branchId,
                key,
                kind,
                subject,
                predicate,
                stableJson(value),
                text,
                searchTokens(`${subject} ${predicate} ${text}`).join(' '),
                '[]',
                current?.observerId ?? null,
                100,
                0.98,
                current ? (current.validFrom ?? null) : seq,
                current?.validTo ?? null,
                seq,
                seq,
                at,
                (current?.revision ?? 0) + 1,
                current?.id ?? null,
                'active',
                JSON.stringify({ ...current?.data, correction: true, commandId }),
                `author-correction:${commandId}`,
              ],
            },
            {
              sql: 'INSERT INTO memory_evidence(memory_id,span_id) VALUES(?,?)',
              params: [id, spanId],
            },
            this.store.memoryHeadSpec(branchId, key),
            ...(current
              ? await this.invalidateDependents(branchId, current.id, 'corrected', seq)
              : []),
            this.indexOutbox(branchId, [...(current ? [current.id] : []), id]),
          ];
        },
      },
    );
    return (
      await this.hydrate([
        (await this.store.one(
          'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
          id,
          this.store.ownerId,
        ))!,
      ])
    )[0];
  }
  private async inactiveVersion(
    branchId: string,
    m: Memory,
    status: 'forgotten' | 'invalidated',
    reason: string,
    recordedSeq?: number,
  ) {
    const b = await this.store.getBranch(branchId),
      id = uuid(),
      at = now();
    return {
      id,
      specs: [
        {
          sql: 'INSERT INTO memory_versions(id,owner_id,story_id,branch_id,memory_key,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          params: [
            id,
            this.store.ownerId,
            b.storyId,
            branchId,
            m.memoryKey,
            m.kind,
            m.subject,
            m.predicate,
            'null',
            '',
            '',
            JSON.stringify([]),
            m.observerId ?? null,
            m.authority ?? 50,
            0,
            null,
            null,
            m.originSeq ?? b.headSeq,
            recordedSeq ?? b.headSeq,
            at,
            m.revision + 1,
            m.id,
            status,
            JSON.stringify({ reason }),
            id,
          ],
        },
        {
          sql: 'INSERT INTO memory_heads(branch_id,memory_key,memory_id) VALUES(?,?,?) ON CONFLICT(branch_id,memory_key) DO UPDATE SET memory_id=excluded.memory_id',
          params: [branchId, m.memoryKey, id],
        },
      ] as QuerySpec[],
    };
  }
  private async invalidateDependents(
    branchId: string,
    id: string,
    reason: string,
    recordedSeq?: number,
  ): Promise<QuerySpec[]> {
    const current = await this.memories(branchId, { includeInactive: true }),
      rows = await this.store.all(
        'WITH RECURSIVE descendants(id) AS (SELECT memory_id FROM memory_dependencies WHERE depends_on_id=? UNION SELECT d.memory_id FROM memory_dependencies d JOIN descendants p ON d.depends_on_id=p.id) SELECT id FROM descendants',
        id,
      ),
      ids = new Set(rows.map((r) => String(r.id))),
      specs: QuerySpec[] = [];
    for (const m of current)
      if (ids.has(m.id))
        specs.push(
          ...(await this.inactiveVersion(branchId, m, 'invalidated', reason, recordedSeq)).specs,
        );
    return specs;
  }
  private indexOutbox(branchId: string, ids: string[]): QuerySpec {
    return {
      sql: 'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      params: [
        uuid(),
        this.store.ownerId,
        branchId,
        'index',
        JSON.stringify({ ownerId: this.store.ownerId, branchId, memoryIds: ids }),
        now(),
        now(),
      ],
    };
  }
  async forget(branchId: string, memoryId: string, reason: string) {
    const current = await this.byId(branchId, memoryId),
      epoch = await this.store.ownerEpoch(),
      branch = await this.store.getBranch(branchId),
      t = await this.inactiveVersion(branchId, current, 'forgotten', reason);
    await this.store.batch([
      this.store.epochGuard(epoch),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [branchId, this.store.ownerId, branch.projectionRevision],
      ),
      ...t.specs,
      ...(await this.invalidateDependents(branchId, memoryId, reason)),
      {
        sql: 'UPDATE owners SET deletion_epoch=deletion_epoch+1 WHERE owner_id=?',
        params: [this.store.ownerId],
      },
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [branchId, this.store.ownerId],
      },
      {
        sql: 'INSERT INTO deletion_tombstones(id,owner_id,kind,target_id,branch_id,generation,reason,created_at) VALUES(?,?,?,?,?,?,?,?)',
        params: [
          uuid(),
          this.store.ownerId,
          'memory',
          current.memoryKey,
          branchId,
          epoch + 1,
          reason,
          now(),
        ],
      },
      this.indexOutbox(branchId, [memoryId]),
      this.store.cleanupGuards(),
    ]);
    return { memoryId: t.id, forgotten: true };
  }
  async deleteSource(sourceId: string, reason: string) {
    const source = await this.store.source(sourceId);
    if (source.status === 'deleted')
      return { sourceId, deleted: true, replayed: true, generation: Number(source.generation) };
    const epoch = await this.store.ownerEpoch(),
      generation = Number(source.generation) + 1,
      deletedAt = now();
    const affected = await this.store.all(
        `WITH RECURSIVE victims(id) AS (SELECT m.id FROM memory_versions m JOIN memory_evidence e ON e.memory_id=m.id JOIN source_spans p ON p.id=e.span_id WHERE m.owner_id=? AND p.source_id=? UNION SELECT d.memory_id FROM memory_dependencies d JOIN victims v ON d.depends_on_id=v.id UNION SELECT m.id FROM memory_versions m JOIN victims v ON m.supersedes_id=v.id WHERE m.status IN ('forgotten','invalidated')) SELECT m.id,m.branch_id FROM memory_versions m JOIN victims v ON v.id=m.id WHERE m.owner_id=?`,
        this.store.ownerId,
        sourceId,
        this.store.ownerId,
      ),
      branches = [...new Set(affected.map((r) => String(r.branch_id)))];
    // A combined observation/fact is destroyed in full. Rebuild only affected
    // branches that still have independently committed, active source evidence;
    // never copy the old combined text or reuse the erased projection.
    const rebuildCandidates = await this.store.all<{ branch_id: string }>(
      `SELECT DISTINCT l.branch_id FROM source_spans p JOIN memory_evidence me ON me.span_id=p.id JOIN memory_versions m ON m.id=me.memory_id JOIN branch_lineage l ON l.ancestor_id=m.branch_id JOIN branches b ON b.id=l.branch_id WHERE m.owner_id=? AND p.source_id=? AND m.status='active' AND (l.max_seq IS NULL OR m.recorded_seq<=l.max_seq) AND (l.max_memory_rowid IS NULL OR m.rowid<=l.max_memory_rowid) AND EXISTS(SELECT 1 FROM memory_evidence other JOIN source_spans remaining ON remaining.id=other.span_id JOIN sources s ON s.id=remaining.source_id WHERE other.memory_id=m.id AND s.id<>? AND s.status='active')`,
      this.store.ownerId,
      sourceId,
      sourceId,
    );
    const rebuildBranches = [];
    for (const candidate of rebuildCandidates) {
      const current = await this.memories(candidate.branch_id);
      if (
        current.some(
          (m) => m.sourceIds.includes(sourceId) && m.sourceIds.some((id) => id !== sourceId),
        )
      )
        rebuildBranches.push(await this.store.getBranch(candidate.branch_id));
    }
    const specs: QuerySpec[] = [
      this.store.epochGuard(epoch),
      ...this.store.sourceGuards([
        { sourceId, version: Number(source.version), generation: Number(source.generation) },
      ]),
      {
        sql: "UPDATE sources SET status='deleted',text=NULL,generation=generation+1,deleted_at=? WHERE id=? AND owner_id=?",
        params: [now(), sourceId, this.store.ownerId],
      },
      {
        sql: 'UPDATE owners SET deletion_epoch=deletion_epoch+1 WHERE owner_id=?',
        params: [this.store.ownerId],
      },
      {
        sql: 'INSERT INTO deletion_tombstones(id,owner_id,kind,target_id,generation,reason,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [uuid(), this.store.ownerId, 'source', sourceId, generation, reason, now()],
      },
      {
        sql: "UPDATE tasks SET cancel_epoch=cancel_epoch+1,status=CASE WHEN status IN ('queued','running','validating','committing') THEN 'cancelled' ELSE status END,draft_text='',context_json='{}',input_json='{}',error_json=NULL,updated_at=? WHERE owner_id=? AND created_at<=?",
        params: [deletedAt, this.store.ownerId, deletedAt],
      },
    ];
    specs.push(
      {
        sql: `WITH RECURSIVE victims(id) AS (SELECT me.memory_id FROM memory_evidence me JOIN source_spans p ON p.id=me.span_id WHERE p.source_id=? UNION SELECT d.memory_id FROM memory_dependencies d JOIN victims v ON d.depends_on_id=v.id UNION SELECT m.id FROM memory_versions m JOIN victims v ON m.supersedes_id=v.id WHERE m.status IN ('forgotten','invalidated')) INSERT OR IGNORE INTO source_deletion_members(source_id,memory_id) SELECT ?,v.id FROM victims v JOIN memory_versions m ON m.id=v.id WHERE m.owner_id=?`,
        params: [sourceId, sourceId, this.store.ownerId],
      },
      {
        sql: 'DELETE FROM memory_fts WHERE memory_id IN (SELECT memory_id FROM source_deletion_members WHERE source_id=?)',
        params: [sourceId],
      },
      {
        sql: 'DELETE FROM memory_heads WHERE memory_id IN (SELECT memory_id FROM source_deletion_members WHERE source_id=?)',
        params: [sourceId],
      },
      // Legacy forget keys can contain a relation value. Keep only an opaque audit
      // identity once its supporting source is explicitly destroyed.
      {
        sql: "UPDATE deletion_tombstones SET target_id=id,reason='来源已删除' WHERE owner_id=? AND kind='memory' AND target_id IN (SELECT memory_key FROM memory_versions WHERE id IN (SELECT memory_id FROM source_deletion_members WHERE source_id=?))",
        params: [this.store.ownerId, sourceId],
      },
      {
        sql: "UPDATE memory_versions SET text='',search_text='',value_json='null',data_json='{}',subject='',predicate='',known_by_json='[]',memory_key=id WHERE id IN (SELECT memory_id FROM source_deletion_members WHERE source_id=?) AND owner_id=?",
        params: [sourceId, this.store.ownerId],
      },
      { sql: "UPDATE source_spans SET quote='' WHERE source_id=?", params: [sourceId] },
      {
        sql: "UPDATE capability_versions SET capability='',data_json='{}',evidence_json='[]' WHERE owner_id=? AND source_memory_id IN (SELECT memory_id FROM source_deletion_members WHERE source_id=?)",
        params: [this.store.ownerId, sourceId],
      },
      {
        sql: "UPDATE procedure_uses SET conditions_json='{}',evidence_json='[]' WHERE owner_id=? AND (revision_id IN (SELECT memory_id FROM source_deletion_members WHERE source_id=?) OR EXISTS(SELECT 1 FROM json_each(evidence_json) j WHERE json_extract(j.value,'$.sourceId')=?))",
        params: [this.store.ownerId, sourceId, sourceId],
      },
      // Scene snapshots are derived text without fine-grained source dependencies.
      // Scrub their whole relevant scope; retained raw events can rebuild safe scenes.
      {
        sql: "UPDATE scene_snapshots SET scene_json='{}' WHERE branch_id IN (SELECT b.id FROM branches b JOIN stories st ON st.id=b.story_id WHERE b.owner_id=? AND st.world_id=? AND (? IS NULL OR st.id=?))",
        params: [this.store.ownerId, source.world_id, source.story_id, source.story_id],
      },
      {
        sql: "UPDATE branches SET scene_json='{}',projection_revision=projection_revision+1 WHERE owner_id=? AND story_id IN (SELECT id FROM stories WHERE world_id=? AND (? IS NULL OR id=?))",
        params: [this.store.ownerId, source.world_id, source.story_id, source.story_id],
      },
    );
    for (const b of branches)
      specs.push(
        this.indexOutbox(
          b,
          affected.filter((r) => r.branch_id === b).map((r) => String(r.id)),
        ),
      );
    for (const branch of rebuildBranches)
      specs.push(
        this.store.guard(
          'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND head_seq=?)',
          [branch.id, this.store.ownerId, branch.headSeq],
        ),
        {
          sql: 'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
          params: [
            uuid(),
            this.store.ownerId,
            branch.id,
            'memory',
            JSON.stringify({
              branchId: branch.id,
              rebuild: true,
              throughSeq: branch.headSeq,
              ownerEpoch: epoch + 1,
              reason: 'remaining-independent-sources',
            }),
            deletedAt,
            deletedAt,
          ],
        },
      );
    specs.push(
      {
        sql: 'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        params: [
          uuid(),
          this.store.ownerId,
          source.branch_id ?? null,
          'cleanup',
          JSON.stringify({
            ownerId: this.store.ownerId,
            sourceId,
            generation,
            assetId: source.asset_id ?? null,
          }),
          now(),
          now(),
        ],
      },
      this.store.cleanupGuards(),
    );
    await this.store.batch(specs);
    return { sourceId, deleted: true, generation, replayed: false };
  }
  async grantKnowledge(input: KnowledgeInput) {
    const b = await this.store.getBranch(input.branchId),
      s = await this.sourceInBranch(input.branchId, input.sourceId),
      chars = Array.from(String(s.text ?? ''));
    let start = input.start,
      end = input.end,
      quote = input.quote;
    if (input.spanId) {
      const p = await this.store.one(
        'SELECT * FROM source_spans WHERE id=? AND source_id=?',
        input.spanId,
        input.sourceId,
      );
      if (!p) throw new StoreError('SPAN_NOT_FOUND', 'Span not found', 404);
      start = Number(p.start_offset);
      end = Number(p.end_offset);
      quote = String(p.quote);
    }
    if (quote != null && start == null) {
      const locations: number[] = [];
      const q = Array.from(quote);
      for (let i = 0; i + q.length <= chars.length; i++)
        if (chars.slice(i, i + q.length).join('') === quote) locations.push(i);
      if (locations.length !== 1)
        throw new StoreError('AMBIGUOUS_QUOTE', 'Supply offsets for ambiguous quoted text', 400);
      start = locations[0];
      end = start + q.length;
    }
    start ??= 0;
    end ??= chars.length;
    quote ??= chars.slice(start, end).join('');
    const e = await this.evidence(
        { sourceId: input.sourceId, start, end, quote, spanId: input.spanId },
        input.branchId,
      ),
      epoch = input.ownerEpoch ?? (await this.store.ownerEpoch()),
      sourceEvent = s.event_id
        ? await this.store.one<{ seq: number }>(
            'SELECT seq FROM events WHERE id=? AND owner_id=?',
            s.event_id,
            this.store.ownerId,
          )
        : null,
      channel = input.channel ?? 'author',
      acquiredSeq = channel === 'author' ? b.headSeq : (sourceEvent?.seq ?? 0);
    if (!input.characterId)
      throw new StoreError('CHARACTER_REQUIRED', 'Knowledge needs a recipient', 400);
    await this.store.batch([
      this.store.epochGuard(epoch),
      ...this.store.sourceGuards([e.fence, ...(input.sourceFence ?? [])]),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [b.id, this.store.ownerId, b.projectionRevision],
      ),
      ...(input.automatic && (input.status ?? 'grant') === 'grant'
        ? [
            this.store.guard(
              `NOT EXISTS(SELECT 1 FROM (
          SELECT g.status,ROW_NUMBER() OVER(PARTITION BY g.span_id,g.character_id ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC) AS rank
          FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id
          JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=?
          WHERE g.owner_id=? AND g.source_id=? AND g.character_id IN (?,'*') AND g.channel='author'
            AND g.acquired_seq<=? AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq)
            AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid)
            AND p.source_version=? AND p.source_generation=? AND p.start_offset<? AND p.end_offset>?
        ) WHERE rank=1 AND status='revoke')`,
              [
                b.id,
                this.store.ownerId,
                input.sourceId,
                input.characterId,
                b.headSeq,
                e.evidence.sourceVersion,
                e.evidence.sourceGeneration,
                e.evidence.end,
                e.evidence.start,
              ],
            ),
          ]
        : []),
      e.spec,
      {
        sql: 'INSERT INTO knowledge_grants(id,owner_id,branch_id,source_id,span_id,character_id,recorded_seq,acquired_seq,channel,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          uuid(),
          this.store.ownerId,
          b.id,
          input.sourceId,
          e.evidence.spanId,
          input.characterId,
          acquiredSeq,
          acquiredSeq,
          input.channel ?? 'author',
          input.status ?? 'grant',
          now(),
        ],
      },
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [b.id, this.store.ownerId],
      },
      this.store.cleanupGuards(),
    ]);
    return {
      ...e.evidence,
      characterId: input.characterId,
      channel: input.channel ?? 'author',
      acquiredSeq,
      status: input.status ?? 'grant',
    };
  }
  grantSource(branchId: string, sourceId: string, characterId: string, status: 'grant' | 'revoke') {
    return this.grantKnowledge({ branchId, sourceId, characterId, status, channel: 'author' });
  }
  async readSourceSpan(
    branchId: string,
    sourceId: string,
    options: { viewer?: string; start?: number; end?: number; asOfSeq?: number } = {},
  ) {
    const s = await this.sourceInBranch(branchId, sourceId, options.asOfSeq),
      chars = Array.from(String(s.text ?? '')),
      viewer = options.viewer ?? 'director';
    let spans: Evidence[] = [];
    const knowledge: { start: number; end: number; acquiredSeq: number; channel: string }[] = [];
    if (viewer === 'director') {
      const start = options.start ?? 0,
        end = options.end ?? chars.length;
      if (start < 0 || end > chars.length || start >= end)
        throw new StoreError('SPAN_RANGE', 'Invalid source range', 400);
      spans = [
        {
          sourceId,
          sourceVersion: Number(s.version),
          sourceGeneration: Number(s.generation),
          start,
          end,
          quote: chars.slice(start, end).join(''),
        },
      ];
    } else {
      const grants = await this.grants(branchId, sourceId, viewer, options.asOfSeq);
      for (const g of grants) {
        if (g.status !== 'grant') continue;
        const start = options.start ?? Number(g.start_offset),
          end = options.end ?? Number(g.end_offset),
          e = {
            sourceId,
            sourceVersion: Number(g.source_version),
            sourceGeneration: Number(g.source_generation),
            start,
            end,
            quote: chars.slice(start, end).join(''),
            spanId: String(g.span_id),
          };
        if (
          start >= Number(g.start_offset) &&
          end <= Number(g.end_offset) &&
          (await this.spanVisible(branchId, e, viewer, options.asOfSeq))
        ) {
          spans.push(e);
          knowledge.push({
            start,
            end,
            acquiredSeq: Number(g.acquired_seq),
            channel: String(g.channel),
          });
        }
      }
      if (!spans.length)
        throw new StoreError('KNOWLEDGE_SCOPE', 'Character has no grant for this source span', 403);
    }
    spans = [...new Map(spans.map((e) => [`${e.start}:${e.end}`, e])).values()];
    return {
      sourceId,
      version: Number(s.version),
      generation: Number(s.generation),
      spans,
      knowledge,
      text: spans.map((e) => e.quote).join('\n'),
    };
  }
  async recall(
    branchId: string,
    query: string,
    options: RecallOptions = {},
  ): Promise<RecallResult> {
    const branch = await this.store.getBranch(branchId),
      all = await this.memories(branchId, { ...options, limit: 5000 }),
      map = new Map(all.map((m) => [m.id, m])),
      cap = Math.max(1, Math.min(options.maxCandidates ?? 120, 500)),
      tokens = searchTokens(query).slice(0, 32),
      degraded: string[] = [],
      arms: string[][] = [];
    const lexicalLimit = Math.min(cap, 40);
    let lexical: string[] = [];
    if (tokens.length) {
      try {
        const terms = tokens.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
        lexical = (
          await this.store.all<{ memory_id: string }>(
            'SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? AND memory_id IN (SELECT value FROM json_each(?)) ORDER BY bm25(memory_fts) LIMIT ?',
            terms,
            JSON.stringify([...map.keys()]),
            lexicalLimit,
          )
        ).map((r) => r.memory_id);
      } catch {
        degraded.push('lexical-fallback');
        lexical = all
          .filter((m) => tokens.some((t) => searchTokens(m.text).includes(t)))
          .map((m) => m.id)
          .slice(0, lexicalLimit);
      }
    }
    const exact = all
        .filter((m) => query.includes(m.subject) || query.includes(m.predicate))
        .map((m) => m.id)
        .slice(0, cap),
      vector = (options.vectorCandidates ?? [])
        .slice()
        .sort((a, b) => b.score - a.score)
        .map((candidate) => candidate.id)
        .filter((id) => map.has(id))
        .slice(0, cap);
    const seedIds = [...new Set([...exact, ...lexical, ...vector])].slice(
        0,
        Math.min(options.graphSeeds ?? 8, 20),
      ),
      graph: string[] = [],
      visited = new Set(seedIds),
      start = performance.now(),
      maxNodes = Math.min(options.maxGraphNodes ?? 96, 300),
      maxHops = Math.min(options.graphHops ?? 2, 3),
      fanout = Math.min(options.graphFanout ?? 8, 24),
      maxMs = options.maxGraphMs ?? 40;
    let frontier = seedIds;
    for (let hop = 0; hop < maxHops && frontier.length; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (performance.now() - start > maxMs) {
          degraded.push('graph-time-budget');
          frontier = [];
          break;
        }
        const m = map.get(id);
        if (!m) continue;
        const neighbors = all
          .filter(
            (n) =>
              !visited.has(n.id) &&
              (n.subject === m.subject ||
                (typeof m.value === 'string' && n.subject === m.value) ||
                (typeof n.value === 'string' && n.value === m.subject)),
          )
          .slice(0, fanout);
        for (const n of neighbors) {
          if (visited.size >= maxNodes) {
            degraded.push('graph-node-budget');
            break;
          }
          visited.add(n.id);
          next.push(n.id);
          graph.push(n.id);
        }
        if (visited.size >= maxNodes) break;
      }
      if (visited.size >= maxNodes) break;
      frontier = next;
    }
    const temporal = all
      .filter(
        (m) =>
          options.sceneTime != null ||
          tokens.some((t) => /time|before|after|昨天|以前|之后/.test(t)),
      )
      .sort((a, b) => (b.validFrom ?? -Infinity) - (a.validFrom ?? -Infinity))
      .slice(0, cap)
      .map((m) => m.id);
    arms.push(exact, lexical, vector, graph, temporal);
    const scores = rrf(arms),
      names = ['exact', 'lexical', 'vector', 'graph', 'temporal'],
      sorted = [...scores].sort((a, b) => b[1].score - a[1].score).slice(0, cap),
      items: RecallResult['items'] = [];
    let used = 0,
      truncated = scores.size > cap;
    const budget = Math.max(0, Math.min(options.maxTokens ?? 3500, 20000));
    for (const [id, score] of sorted) {
      const m = map.get(id)!;
      const cost =
        estimateTokens(m.text) + m.evidence.reduce((n, e) => n + estimateTokens(e.quote), 0) + 32;
      if (used + cost > budget) {
        truncated = true;
        continue;
      }
      used += cost;
      items.push({
        memory: m,
        score: score.score,
        arms: score.arms.map((i) => names[i]),
        evidence: m.evidence,
      });
    }
    const cursor = await this.store.one<{ cursor: number }>(
      'SELECT COALESCE(MAX(applied_seq),0) AS cursor FROM memory_cursors WHERE branch_id=? AND extractor_version NOT LIKE ? AND extractor_version NOT LIKE ?',
      branchId,
      '%observer%',
      '%observation%',
    );
    return {
      items,
      tokens: used,
      visited: visited.size,
      truncated,
      degraded: [...new Set(degraded)],
      cursor: cursor?.cursor ?? 0,
    };
  }
  async addExperience(input: ExperienceInput) {
    if (input.ownerEpoch != null && input.ownerEpoch !== (await this.store.ownerEpoch()))
      throw new StoreError('STALE_WRITE', 'State changed; refresh and retry.');
    if (!input.steps.length || !input.capability)
      throw new StoreError('EXPERIENCE_INPUT', 'Experience needs a method and capability', 400);
    const branch = await this.store.getBranch(input.branchId),
      epoch = input.ownerEpoch ?? (await this.store.ownerEpoch()),
      conditionKey = await digest(input.conditions),
      methodKey = await digest(input.steps),
      known = [input.actorId],
      episodeIds: string[] = [];
    for (const sourceId of [...new Set(input.evidence.map((e) => e.sourceId))]) {
      const e = await this.store.one<{ branch_id: string; request_id: string; role: string }>(
        'SELECT branch_id,request_id,role FROM events WHERE source_id=? AND owner_id=?',
        sourceId,
        this.store.ownerId,
      );
      if (e?.role === 'assistant') episodeIds.push(`${e.branch_id}:${e.request_id}`);
    }
    const executionIds = [...new Set(episodeIds)].sort(),
      experienceInput: MemoryProposal = {
        kind: 'experience',
        subject: input.actorId,
        predicate: input.capability,
        value: input.outcome,
        text: input.text || `${input.actorId} 使用 ${input.capability}：${input.outcome}`,
        memoryKey: `experience:${input.actorId}:${input.capability}:${executionIds.join(':') || input.evidence.map((e) => e.sourceId).join(':')}:${conditionKey}:${methodKey}`,
        originSeq: input.originSeq,
        evidence: input.evidence,
        knownBy: known,
        data: {
          actorId: input.actorId,
          capability: input.capability,
          conditions: input.conditions,
          conditionKey,
          steps: input.steps,
          methodKey,
          outcome: input.outcome,
          failureCategory: input.failureCategory ?? 'unresolved',
          episodeIds: executionIds,
        },
      };
    const expPrepared = await this.prepare(input.branchId, experienceInput),
      expIdem = expPrepared.specs
        .find((s) => s.sql.startsWith('INSERT INTO memory_versions'))!
        .params!.at(-1),
      existing = await this.store.one(
        'SELECT * FROM memory_versions WHERE owner_id=? AND branch_id=? AND idempotency_key=?',
        this.store.ownerId,
        input.branchId,
        expIdem,
      );
    const experience = existing
      ? (await this.hydrate([existing]))[0]
      : ({
          ...expPrepared.memory,
          id: expPrepared.id,
          memoryKey: expPrepared.key,
          ownerId: this.store.ownerId,
          storyId: branch.storyId,
          branchId: branch.id,
          recordedSeq: expPrepared.memory.originSeq ?? 0,
          recordedAt: now(),
          revision: 1,
          status: 'active',
          sourceIds: [...new Set(input.evidence.map((e) => e.sourceId))],
          supersedesId: null,
          knownBy: expPrepared.memory.knownBy ?? [],
        } as Memory);
    const experienceList = (await this.memories(input.branchId, { kinds: ['experience'] })).filter(
      (m) =>
        m.subject === input.actorId &&
        m.predicate === input.capability &&
        m.data?.conditionKey === conditionKey &&
        m.data?.methodKey === methodKey &&
        m.memoryKey !== experience.memoryKey,
    );
    experienceList.push(experience);
    const successes: Memory[] = [];
    for (const m of experienceList.filter(
      (m) =>
        m.value === 'success' && Array.isArray(m.data?.episodeIds) && m.data.episodeIds.length > 0,
    )) {
      const episodes = m.data!.episodeIds as string[];
      if (
        successes.every((s) =>
          (s.data!.episodeIds as string[]).every((id) => !episodes.includes(id)),
        )
      )
        successes.push(m);
    }
    const failures = experienceList.filter((m) => m.value === 'failure' || m.value === 'partial'),
      counterexamples = failures.filter((m) =>
        ['method_counterexample', 'contradiction', 'unsafe'].includes(
          String(m.data?.failureCategory),
        ),
      ),
      unresolved = failures.filter((m) => m.data?.failureCategory === 'unresolved'),
      capability = (await this.capabilities(input.branchId, input.actorId)).find(
        (c) => c.capability === input.capability && c.status === 'available',
      ),
      procKey = `procedure:${input.actorId}:${input.capability}:${conditionKey}:${methodKey}`;
    const previous = (
        await this.memories(input.branchId, { includeInactive: true, kinds: ['procedure'] })
      ).find((m) => m.memoryKey === procKey),
      status = counterexamples.length
        ? 'suspended'
        : successes.length >= 2 && capability && !unresolved.length
          ? 'active'
          : 'draft';
    const support = [
        ...new Map(
          [...experienceList.flatMap((m) => m.evidence), ...(capability?.evidence ?? [])].map(
            (e) => [e.spanId ?? `${e.sourceId}:${e.start}:${e.end}`, e],
          ),
        ).values(),
      ],
      procedureInput: MemoryProposal = {
        kind: 'procedure',
        subject: input.actorId,
        predicate: input.capability,
        value: input.steps,
        text: `${input.capability}：${input.steps.join(' → ')}`,
        memoryKey: procKey,
        status,
        knownBy: known,
        evidence: support.slice(0, 128),
        data: {
          conditions: input.conditions,
          conditionKey,
          steps: input.steps,
          methodKey,
          successes: successes.length,
          failures: failures.length,
          counterexamples: counterexamples.map((m) => m.id),
          unresolved: unresolved.map((m) => m.id),
          experienceIds: experienceList.map((m) => m.id),
          requiredCapabilityRevision: capability?.revisionId ?? null,
          activationRule: 'available-capability-and-two-independent-execution-successes',
          previousRevision: previous?.id ?? null,
        },
      };
    const procPrepared = await this.prepare(input.branchId, procedureInput),
      procIdem = procPrepared.specs
        .find((s) => s.sql.startsWith('INSERT INTO memory_versions'))!
        .params!.at(-1),
      existingProc = await this.store.one(
        'SELECT * FROM memory_versions WHERE owner_id=? AND branch_id=? AND idempotency_key=?',
        this.store.ownerId,
        input.branchId,
        procIdem,
      ),
      procedureId = existingProc ? String(existingProc.id) : procPrepared.id;
    await this.store.batch([
      this.store.epochGuard(epoch),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [branch.id, this.store.ownerId, branch.projectionRevision],
      ),
      ...this.store.sourceGuards([
        ...expPrepared.fences,
        ...procPrepared.fences,
        ...(input.sourceFence ?? []),
      ]),
      ...(existing ? [] : expPrepared.specs),
      ...(existingProc ? [] : procPrepared.specs),
      ...experienceList.map((m) => ({
        sql: 'INSERT OR IGNORE INTO memory_dependencies(memory_id,depends_on_id) VALUES(?,?)',
        params: [procedureId, m.id],
      })),
      ...(capability
        ? [
            {
              sql: 'INSERT OR IGNORE INTO memory_dependencies(memory_id,depends_on_id) VALUES(?,?)',
              params: [procedureId, capability.revisionId],
            },
          ]
        : []),
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [branch.id, this.store.ownerId],
      },
      this.store.cleanupGuards(),
    ]);
    const procedure = (
      await this.hydrate([
        (await this.store.one(
          'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
          procedureId,
          this.store.ownerId,
        ))!,
      ])
    )[0];
    return {
      experience: (
        await this.hydrate([
          (await this.store.one(
            'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
            experience.id,
            this.store.ownerId,
          ))!,
        ])
      )[0],
      procedure,
    };
  }
  async useProcedure(input: ProcedureUseInput) {
    const m = await this.byRevision(input.branchId, input.revisionId ?? input.procedureId),
      identity =
        input.procedureId === m.id ? m : await this.byRevision(input.branchId, input.procedureId);
    if (m.kind !== 'procedure' || identity.memoryKey !== m.memoryKey)
      throw new StoreError('PROCEDURE_KIND', 'Memory is not this procedure', 400);
    const branch = await this.store.getBranch(input.branchId),
      phase = input.phase ?? 'applied',
      prepared = [];
    for (const e of input.evidence) prepared.push(await this.evidence(e, input.branchId));
    if (
      phase === 'applied' &&
      ['success', 'failure', 'partial'].includes(input.outcome) &&
      !prepared.length
    )
      throw new StoreError('PROCEDURE_EVIDENCE', 'Applied outcome needs evidence', 400);
    const attemptRows = await this.store.all<{
        branch_id: string;
        request_id: string;
        seq: number;
      }>(
        "SELECT branch_id,request_id,seq FROM events WHERE owner_id=? AND source_id IN (SELECT value FROM json_each(?)) AND role='assistant' ORDER BY seq DESC",
        this.store.ownerId,
        JSON.stringify([...new Set(input.evidence.map((e) => e.sourceId))]),
      ),
      attempt = attemptRows[0] ? `${attemptRows[0].branch_id}:${attemptRows[0].request_id}` : null;
    const conditions = input.conditions ?? (m.data?.conditions as Record<string, Json>) ?? {},
      epoch = input.ownerEpoch ?? (await this.store.ownerEpoch()),
      id = await digest({
        ownerId: this.store.ownerId,
        branchId: input.branchId,
        revisionId: m.id,
        phase,
        usageKey: input.usageKey ?? null,
        outcome: input.outcome,
        category: input.failureCategory ?? null,
        conditions,
        attempt,
        evidence: attempt
          ? null
          : prepared
              .map((e) => ({
                sourceId: e.evidence.sourceId,
                version: e.evidence.sourceVersion,
                generation: e.evidence.sourceGeneration,
                start: e.evidence.start,
                end: e.evidence.end,
              }))
              .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
      }),
      existing = await this.store.one(
        'SELECT id FROM procedure_uses WHERE id=? AND owner_id=?',
        id,
        this.store.ownerId,
      );
    await this.store.batch([
      this.store.epochGuard(epoch),
      ...this.store.sourceGuards([...prepared.map((e) => e.fence), ...(input.sourceFence ?? [])]),
      ...prepared.map((e) => e.spec),
      {
        sql: 'INSERT OR IGNORE INTO procedure_uses(id,owner_id,branch_id,procedure_id,revision_id,phase,outcome,category,conditions_json,evidence_json,recorded_seq,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          this.store.ownerId,
          input.branchId,
          input.procedureId,
          m.id,
          phase,
          input.outcome,
          input.failureCategory ?? null,
          JSON.stringify(conditions),
          JSON.stringify(prepared.map((e) => e.evidence)),
          Math.max(branch.headSeq, ...attemptRows.map((e) => e.seq)),
          now(),
        ],
      },
      this.store.cleanupGuards(),
    ]);
    // Replaying this second step also repairs a crash after the use ledger committed.
    if (phase === 'applied' && ['success', 'failure', 'partial'].includes(input.outcome))
      return {
        id,
        phase,
        replayed: !!existing,
        ...(await this.addExperience({
          branchId: input.branchId,
          actorId: m.subject,
          capability: m.predicate,
          conditions,
          steps: (m.data?.steps as string[]) ?? [],
          outcome: input.outcome,
          failureCategory: input.failureCategory,
          evidence: input.evidence,
          ownerEpoch: epoch,
          sourceFence: input.sourceFence,
        })),
      };
    return { id, phase, counted: false, replayed: !!existing };
  }
  async setCapability(input: CapabilityInput) {
    if (input.ownerEpoch != null && input.ownerEpoch !== (await this.store.ownerEpoch()))
      throw new StoreError('STALE_WRITE', 'State changed; refresh and retry.');
    const branch = await this.store.getBranch(input.branchId),
      epoch = input.ownerEpoch ?? (await this.store.ownerEpoch()),
      prepared = await this.prepare(input.branchId, {
        kind: 'canon',
        subject: input.actorId,
        predicate: `capability:${input.capability}`,
        value: input.status,
        text: `${input.actorId} · ${input.capability} · ${input.status}`,
        evidence: input.evidence,
        knownBy: [input.actorId],
        data: { ...input.data, recordType: 'capability' },
        sourceFence: input.sourceFence,
      }),
      id = uuid(),
      idem = prepared.specs
        .find((q) => q.sql.startsWith('INSERT INTO memory_versions'))!
        .params!.at(-1),
      existing = await this.store.one(
        'SELECT id FROM memory_versions WHERE owner_id=? AND branch_id=? AND idempotency_key=?',
        this.store.ownerId,
        branch.id,
        idem,
      );
    if (existing) {
      const cap = await this.store.one(
        'SELECT * FROM capability_versions WHERE owner_id=? AND branch_id=? AND source_memory_id=?',
        this.store.ownerId,
        branch.id,
        existing.id,
      );
      if (cap)
        return {
          id: String(cap.id),
          revisionId: String(cap.source_memory_id),
          actorId: String(cap.actor_id),
          capability: String(cap.capability),
          status: cap.status as Capability['status'],
          data: json<Record<string, Json>>(cap.data_json, {}),
          evidence: json<Evidence[]>(cap.evidence_json, []),
          recordedSeq: Number(cap.recorded_seq),
        };
    }
    await this.store.batch([
      this.store.epochGuard(epoch),
      this.store.guard(
        'EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND projection_revision=?)',
        [branch.id, this.store.ownerId, branch.projectionRevision],
      ),
      ...this.store.sourceGuards(prepared.fences),
      ...prepared.specs,
      {
        sql: 'INSERT INTO capability_versions(id,owner_id,branch_id,actor_id,capability,status,data_json,evidence_json,source_memory_id,recorded_seq,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          this.store.ownerId,
          input.branchId,
          input.actorId,
          input.capability,
          input.status,
          JSON.stringify(input.data ?? {}),
          JSON.stringify(prepared.memory.evidence),
          prepared.id,
          prepared.memory.originSeq ?? 0,
          now(),
        ],
      },
      {
        sql: 'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=? AND owner_id=?',
        params: [branch.id, this.store.ownerId],
      },
      this.store.cleanupGuards(),
    ]);
    return {
      id,
      revisionId: prepared.id,
      actorId: input.actorId,
      capability: input.capability,
      status: input.status,
      data: input.data ?? {},
      evidence: prepared.memory.evidence,
      recordedSeq: prepared.memory.originSeq ?? 0,
    };
  }
  async capabilities(branchId: string, actorId?: string): Promise<Capability[]> {
    const b = await this.store.getBranch(branchId),
      memories = new Set((await this.memories(branchId)).map((m) => m.id)),
      rows = await this.store.all(
        `SELECT * FROM (SELECT c.*,ROW_NUMBER() OVER(PARTITION BY c.actor_id,c.capability ORDER BY c.recorded_seq DESC,c.rowid DESC,l.depth ASC) AS rank FROM capability_versions c JOIN branch_lineage l ON l.ancestor_id=c.branch_id AND l.branch_id=? WHERE c.owner_id=? AND c.recorded_seq<=? AND (l.max_seq IS NULL OR c.recorded_seq<=l.max_seq) AND (l.max_capability_rowid IS NULL OR c.rowid<=l.max_capability_rowid)) WHERE rank=1 ${actorId ? 'AND actor_id=?' : ''}`,
        branchId,
        this.store.ownerId,
        b.headSeq,
        ...(actorId ? [actorId] : []),
      );
    return rows
      .filter((r) => memories.has(String(r.source_memory_id)))
      .map((r) => ({
        id: String(r.id),
        actorId: String(r.actor_id),
        capability: String(r.capability),
        status: r.status as Capability['status'],
        data: json(r.data_json, {}),
        evidence: json(r.evidence_json, []),
        recordedSeq: Number(r.recorded_seq),
        revisionId: String(r.source_memory_id),
      }));
  }
  async setProcedureStatus(
    branchId: string,
    targetId: string,
    status: 'active' | 'suspended' | 'retired' | 'draft',
    options: { commandId?: string; expectedHead?: number } = {},
  ) {
    const commandId = options.commandId ?? uuid(),
      fingerprint = { kind: 'procedure-status', targetId, status },
      id = `procedure_status_${await digest({ ownerId: this.store.ownerId, branchId, commandId })}`;
    if (commandId.length < 8 || commandId.length > 200)
      throw new StoreError('PROCEDURE_COMMAND', '技能操作需要有效幂等键', 400);
    const prior = await this.store.one<{ session_id: string }>(
      'SELECT session_id FROM turns WHERE owner_id=? AND branch_id=? AND request_id=?',
      this.store.ownerId,
      branchId,
      commandId,
    );
    if (prior) {
      const existing = await this.store.one(
        'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
        id,
        this.store.ownerId,
      );
      if (!existing) throw new StoreError('IDEMPOTENCY_REUSE', '该幂等键属于其他操作');
      const projection = (await this.hydrate([existing]))[0]!;
      const text = String(projection.data?.authorStatusText ?? '');
      await this.store.appendTurn(
        {
          branchId,
          sessionId: prior.session_id,
          requestId: commandId,
          messages: [{ role: 'correction', text }],
        },
        { fingerprint, prepare: async () => [] },
      );
      return projection;
    }
    const branch = await this.store.getBranch(branchId),
      epoch = await this.store.ownerEpoch(),
      current = await this.byId(branchId, targetId);
    if (current.kind !== 'procedure')
      throw new StoreError('PROCEDURE_KIND', 'Memory is not a procedure', 400);
    let requiredCapability: Capability | undefined;
    if (status === 'active') {
      const capability = (await this.capabilities(branchId, current.subject)).find(
        (c) => c.capability === current.predicate && c.status === 'available',
      );
      if (
        !capability ||
        Number(current.data?.successes ?? 0) < 2 ||
        ((current.data?.counterexamples as Json[]) ?? []).length ||
        ((current.data?.unresolved as Json[]) ?? []).length
      )
        throw new StoreError(
          'PROCEDURE_PROMOTION',
          'Skill needs available capability and two independent successes without unresolved counterexamples',
          422,
        );
      requiredCapability = capability;
    }
    if (current.status === status) return current;
    const session = (await this.store.listSessions(branchId))[0];
    if (!session) throw new StoreError('SESSION_SCOPE', '技能操作需要当前故事的聊天', 400);
    const label = { active: '可用', suspended: '暂停', retired: '停用', draft: '候选' }[status],
      text = `作者将「${current.predicate}」标记为${label}。`,
      fences: SourceFence[] = [];
    for (const proof of current.evidence) {
      const source = await this.store.source(proof.sourceId);
      fences.push({
        sourceId: proof.sourceId,
        version: Number(source.version),
        generation: Number(source.generation),
      });
    }
    let projectionRevision = branch.projectionRevision;
    const targetSnapshot = stableJson(current);
    // Background observation/index projections can advance independently of plot.
    // Retry only that fence: plot, target revision, capability and deletion state stay fixed.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.store.appendTurn(
          {
            branchId,
            sessionId: session.id,
            requestId: commandId,
            expectedHead: options.expectedHead ?? branch.headSeq,
            expectedProjectionRevision: projectionRevision,
            ownerEpoch: epoch,
            sourceFence: fences,
            messages: [{ role: 'correction', text }],
          },
          {
            fingerprint,
            advanceOwnerEpoch: true,
            prepare: async (events, at) => {
              const source = events[0]!,
                spanId = uuid(),
                seq = source.seq;
              return [
                {
                  sql: 'INSERT INTO source_spans(id,source_id,source_version,source_generation,start_offset,end_offset,quote,created_at) VALUES(?,?,1,0,0,?,?,?)',
                  params: [spanId, source.sourceId, Array.from(text).length, text, at],
                },
                {
                  sql: 'INSERT INTO knowledge_grants(id,owner_id,branch_id,source_id,span_id,character_id,recorded_seq,acquired_seq,channel,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                  params: [
                    uuid(),
                    this.store.ownerId,
                    branchId,
                    source.sourceId,
                    spanId,
                    current.subject,
                    seq,
                    seq,
                    'author',
                    'grant',
                    at,
                  ],
                },
                {
                  sql: 'INSERT INTO memory_versions(id,owner_id,story_id,branch_id,memory_key,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                  params: [
                    id,
                    this.store.ownerId,
                    branch.storyId,
                    branchId,
                    current.memoryKey,
                    'procedure',
                    current.subject,
                    current.predicate,
                    stableJson(current.value),
                    current.text,
                    searchTokens(`${current.subject} ${current.predicate} ${current.text}`).join(
                      ' ',
                    ),
                    JSON.stringify(current.knownBy),
                    current.observerId ?? null,
                    current.authority ?? 70,
                    current.confidence ?? 0.85,
                    current.validFrom ?? null,
                    current.validTo ?? null,
                    seq,
                    seq,
                    at,
                    current.revision + 1,
                    current.id,
                    status,
                    JSON.stringify({
                      ...current.data,
                      manualStatus: status,
                      authorConfirmationEvent: source.eventId,
                      authorStatusText: text,
                    }),
                    `procedure-status:${commandId}`,
                  ],
                },
                ...[...current.evidence.map((proof) => proof.spanId!), spanId].map((proofId) => ({
                  sql: 'INSERT INTO memory_evidence(memory_id,span_id) VALUES(?,?)',
                  params: [id, proofId],
                })),
                {
                  sql: 'INSERT INTO memory_dependencies(memory_id,depends_on_id) SELECT ?,depends_on_id FROM memory_dependencies WHERE memory_id=?',
                  params: [id, current.id],
                },
                this.store.memoryHeadSpec(branchId, current.memoryKey),
                this.indexOutbox(branchId, [current.id, id]),
              ];
            },
          },
        );
        break;
      } catch (error) {
        if (!(error instanceof StoreError) || error.code !== 'STALE_WRITE' || attempt >= 3)
          throw error;
        const next = await this.store.getBranch(branchId);
        if (
          next.headSeq !== branch.headSeq ||
          next.headSeq !== (options.expectedHead ?? branch.headSeq) ||
          next.projectionRevision === projectionRevision ||
          (await this.store.ownerEpoch()) !== epoch
        )
          throw error;
        let nextTarget: Memory;
        try {
          nextTarget = await this.byId(branchId, targetId);
        } catch {
          throw error;
        }
        if (stableJson(nextTarget) !== targetSnapshot) throw error;
        if (requiredCapability) {
          const nextCapability = (await this.capabilities(branchId, current.subject)).find(
            (c) => c.capability === current.predicate && c.status === 'available',
          );
          if (stableJson(nextCapability) !== stableJson(requiredCapability)) throw error;
        }
        projectionRevision = next.projectionRevision;
      }
    }
    return (
      await this.hydrate([
        (await this.store.one(
          'SELECT * FROM memory_versions WHERE id=? AND owner_id=?',
          id,
          this.store.ownerId,
        ))!,
      ])
    )[0];
  }
}
