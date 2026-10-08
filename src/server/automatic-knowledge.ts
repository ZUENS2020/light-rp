import type { Store } from './store';
import type { AutomaticKnowledgeGrant } from './extraction';
export async function applyAutomaticKnowledge(
  s: Store,
  branchId: string,
  grants: AutomaticKnowledgeGrant[],
  scopes: string[],
  options: { ownerEpoch?: number; sourceFence?: Parameters<Store['extract']>[1]['sourceFence'] },
) {
  const seen = new Set<string>();
  for (const grant of grants.filter((grant) => scopes.includes(grant.path.split('.')[0]!))) {
    const evidence = grant.evidence,
      identity = `${grant.actorId}:${evidence.sourceId}:${evidence.start}:${evidence.end}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const authorRevoke = await s.one(
      `SELECT 1 AS revoked FROM (
       SELECT g.status,ROW_NUMBER() OVER(PARTITION BY g.span_id,g.character_id ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC) AS rank
       FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id
       JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=?
       WHERE g.owner_id=? AND g.character_id IN (?,'*') AND g.source_id=? AND g.channel='author'
       AND p.start_offset<? AND p.end_offset>? AND p.source_version=? AND p.source_generation=?
       AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq)
       AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid))
       WHERE rank=1 AND status='revoke' LIMIT 1`,
      branchId,
      s.ownerId,
      grant.actorId,
      evidence.sourceId,
      evidence.end,
      evidence.start,
      evidence.sourceVersion ?? 1,
      evidence.sourceGeneration ?? 0,
    );
    if (authorRevoke) continue;
    // An idempotent replay neither duplicates a grant nor reverses an explicit
    // revocation of that same span. Source/owner fences are still checked on a
    // new write by MemoryEngine in its transaction.
    const existing = await s.one(
      `SELECT g.status FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id
       JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=?
       WHERE g.owner_id=? AND g.character_id IN (?,'*') AND g.source_id=?
       AND p.start_offset<=? AND p.end_offset>=? AND p.source_version=? AND p.source_generation=?
       AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq)
       AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid)
       ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC LIMIT 1`,
      branchId,
      s.ownerId,
      grant.actorId,
      evidence.sourceId,
      evidence.start,
      evidence.end,
      evidence.sourceVersion ?? 1,
      evidence.sourceGeneration ?? 0,
    );
    if (existing) continue;
    await s.grantKnowledge({
      branchId,
      characterId: grant.actorId,
      sourceId: evidence.sourceId,
      quote: evidence.quote,
      start: evidence.start,
      end: evidence.end,
      channel: grant.channel,
      automatic: true,
      ...options,
    });
  }
}
