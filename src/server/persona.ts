import { Store, StoreError, digest, json, now, stableJson } from './store';
import type { Capability, Evidence } from '../shared/domain';

export interface PersonaCapability {
  name: string;
  level?: string;
}
export interface PersonaSyncResult {
  sources: { assetId: string; revision: number; sourceId: string; status: 'active' | 'deleted' }[];
  capabilities: Capability[];
  skipped: {
    assetId: string;
    revision: number;
    capability?: string;
    reason: 'deleted-source' | 'independent-source';
  }[];
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};

/**
 * Explicit author configuration only, for plain cards or V2/V3 data wrappers:
 * {"data":{"extensions":{"lightrp":{"capabilities":[{"name":"解锁","level":"初级"}]}}}}
 * Descriptions, examples, worldbooks and successful outcomes never imply abilities.
 */
export function personaCapabilities(raw: unknown): PersonaCapability[] {
  const wrapper = object(raw),
    card = Object.prototype.hasOwnProperty.call(wrapper, 'data') ? object(wrapper.data) : wrapper;
  const configured = object(object(card.extensions).lightrp).capabilities;
  if (configured == null) return [];
  if (!Array.isArray(configured) || configured.length > 128)
    throw new StoreError('PERSONA_CAPABILITIES', '角色卡能力配置必须是至多 128 项的数组', 422);
  const byName = new Map<string, PersonaCapability>();
  for (const input of configured) {
    const entry = object(input),
      name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (
      !name ||
      name.length > 200 ||
      (entry.level != null && (typeof entry.level !== 'string' || entry.level.length > 200))
    )
      throw new StoreError(
        'PERSONA_CAPABILITIES',
        '每项角色卡能力需要明确 name；level 可选且必须是文字',
        422,
      );
    const capability: PersonaCapability = {
        name,
        ...(typeof entry.level === 'string' ? { level: entry.level.trim() } : {}),
      },
      previous = byName.get(name);
    if (previous && stableJson(previous) !== stableJson(capability))
      throw new StoreError('PERSONA_CAPABILITIES', '同一角色卡能力不能配置两个不同级别', 422);
    byName.set(name, capability);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Dynamic class construction also permits Store to call this module without an import-cycle TDZ. */
function prefixView(store: Store, branchId: string, prefix: number): Store {
  class PersonaPrefixStore extends Store {
    override async getBranch(id: string) {
      const branch = await store.getBranch(id);
      return id === branchId ? { ...branch, headSeq: Math.min(branch.headSeq, prefix) } : branch;
    }
    override getResourceBindings(id: string, asOfSeq?: number) {
      return store.getResourceBindings(
        id,
        id === branchId ? Math.min(asOfSeq ?? prefix, prefix) : asOfSeq,
      );
    }
  }
  return new PersonaPrefixStore(store.db, store.ownerId);
}

/**
 * Projects configured abilities into a branch without changing its event head.
 * Every revision has a canonical world source; deletion tombstones always win.
 * A binding's author event provides the recorded-time origin for later revisions.
 */
export async function syncPersonaCapabilities(
  store: Store,
  branchId: string,
  asOfSeq?: number,
  ownerEpoch?: number,
): Promise<PersonaSyncResult> {
  const branch = await store.getBranch(branchId),
    prefix = asOfSeq ?? branch.headSeq;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > branch.headSeq)
    throw new StoreError('PERSONA_PREFIX', '角色资料历史回合无效', 400);
  const epoch = ownerEpoch ?? (await store.ownerEpoch());
  if ((await store.ownerEpoch()) !== epoch)
    throw new StoreError('STALE_WRITE', '角色资料来源已变化，请重新同步');
  const story = await store.getStory(branch.storyId),
    bindings = (await store.getResourceBindings(branchId, prefix)).filter(
      (binding) => binding.kind === 'character',
    ),
    view = prefixView(store, branchId, prefix),
    result: PersonaSyncResult = { sources: [], capabilities: [], skipped: [] };
  const existing = new Map(
    (await view.listCapabilities(branchId)).map((capability) => [
      `${capability.actorId}:${capability.capability}`,
      capability,
    ]),
  );
  for (const binding of bindings) {
    const asset = await store.one<{ raw_json: string }>(
      "SELECT r.raw_json FROM asset_revisions r JOIN assets a ON a.id=r.asset_id WHERE r.asset_id=? AND r.revision=? AND a.owner_id=? AND a.kind='character'",
      binding.assetId,
      binding.revision,
      store.ownerId,
    );
    if (!asset) throw new StoreError('PERSONA_RESOURCE', '角色卡的绑定版本不存在', 422);
    const configured = personaCapabilities(json<unknown>(asset.raw_json, {})),
      text = stableJson({ capabilities: configured }),
      sourceId = `persona_${await digest({ ownerId: store.ownerId, worldId: story.worldId, assetId: binding.assetId, revision: binding.revision })}`;
    const prior = await store.one<{
        status: string;
        version: number;
        generation: number;
        text: string | null;
      }>(
        'SELECT status,version,generation,text FROM sources WHERE id=? AND owner_id=?',
        sourceId,
        store.ownerId,
      ),
      tombstone = await store.one(
        "SELECT id FROM deletion_tombstones WHERE owner_id=? AND kind='source' AND target_id=?",
        store.ownerId,
        sourceId,
      );
    if (prior?.status === 'deleted' || tombstone) {
      result.sources.push({
        assetId: binding.assetId,
        revision: binding.revision,
        sourceId,
        status: 'deleted',
      });
      result.skipped.push({
        assetId: binding.assetId,
        revision: binding.revision,
        reason: 'deleted-source',
      });
      continue;
    }
    if (prior && (prior.version !== binding.revision || prior.text !== text))
      throw new StoreError(
        'PERSONA_REVISION',
        '同一角色卡版本的明确能力配置已变化，请创建新资料版本',
        409,
      );
    await store.batch([
      store.epochGuard(epoch),
      store.guard(
        "NOT EXISTS(SELECT 1 FROM deletion_tombstones WHERE owner_id=? AND kind='source' AND target_id=?)",
        [store.ownerId, sourceId],
      ),
      store.guard(
        'EXISTS(SELECT 1 FROM asset_revisions r JOIN assets a ON a.id=r.asset_id WHERE r.asset_id=? AND r.revision=? AND a.owner_id=? AND r.raw_json=?)',
        [binding.assetId, binding.revision, store.ownerId, asset.raw_json],
      ),
      {
        sql: 'INSERT OR IGNORE INTO sources(id,owner_id,world_id,kind,asset_id,version,text,known_by_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [
          sourceId,
          store.ownerId,
          story.worldId,
          'character_card',
          binding.assetId,
          binding.revision,
          text,
          '[]',
          now(),
        ],
      },
      ...store.sourceGuards([
        { sourceId, version: binding.revision, generation: prior?.generation ?? 0 },
      ]),
      store.cleanupGuards(),
    ]);
    result.sources.push({
      assetId: binding.assetId,
      revision: binding.revision,
      sourceId,
      status: 'active',
    });
    const installed = await store.one<{ recorded_seq: number }>(
      `SELECT rb.recorded_seq FROM resource_bindings rb JOIN branch_lineage l ON l.ancestor_id=rb.branch_id AND l.branch_id=? WHERE rb.owner_id=? AND rb.asset_id=? AND rb.revision=? AND rb.recorded_seq<=? AND (l.max_seq IS NULL OR rb.recorded_seq<=l.max_seq) AND (l.max_binding_rowid IS NULL OR rb.rowid<=l.max_binding_rowid) ORDER BY rb.recorded_seq DESC,rb.rowid DESC,l.depth ASC LIMIT 1`,
      branchId,
      store.ownerId,
      binding.assetId,
      binding.revision,
      prefix,
    );
    if (!installed) throw new StoreError('PERSONA_BINDING', '角色卡版本未绑定到该历史回合', 409);
    const bindingEvent =
      installed.recorded_seq > 0
        ? (
            await store.getEvents(branchId, {
              asOfSeq: installed.recorded_seq,
              afterSeq: installed.recorded_seq - 1,
              limit: 1,
            })
          )[0]
        : undefined;
    if (installed.recorded_seq > 0 && !bindingEvent)
      throw new StoreError('PERSONA_BINDING', '角色卡版本变更缺少已提交的来源事件', 409);
    // A deleted binding event cannot authorize resurrection of its configured abilities.
    if (bindingEvent?.deleted) continue;
    for (const capability of configured) {
      const previous = existing.get(`${binding.assetId}:${capability.name}`);
      if (previous && previous.data.origin !== 'persona') {
        result.skipped.push({
          assetId: binding.assetId,
          revision: binding.revision,
          capability: capability.name,
          reason: 'independent-source',
        });
        continue;
      }
      // Replaying unchanged card state must not add grants or undo a later knowledge revocation.
      if (
        previous?.status === 'available' &&
        previous.data.assetId === binding.assetId &&
        previous.data.assetRevision === binding.revision &&
        previous.data.level === (capability.level ?? null) &&
        previous.evidence.some(
          (proof) =>
            proof.sourceId === sourceId &&
            proof.sourceVersion === binding.revision &&
            proof.sourceGeneration === (prior?.generation ?? 0),
        )
      )
        continue;
      const quote = stableJson(capability),
        offset = text.indexOf(quote),
        start = Array.from(text.slice(0, offset)).length,
        evidence: Evidence[] = [
          {
            sourceId,
            sourceVersion: binding.revision,
            sourceGeneration: prior?.generation ?? 0,
            start,
            end: start + Array.from(quote).length,
            quote,
          },
        ];
      if (offset < 0)
        throw new StoreError('PERSONA_SOURCE', '角色卡能力配置无法定位到来源片段', 500);
      if (bindingEvent)
        evidence.push({
          sourceId: bindingEvent.sourceId,
          start: 0,
          end: Array.from(bindingEvent.text).length,
          quote: bindingEvent.text,
        });
      const sourceFence = [];
      for (const proof of evidence) {
        const source = await store.source(proof.sourceId);
        sourceFence.push({
          sourceId: proof.sourceId,
          version: Number(source.version),
          generation: Number(source.generation),
        });
        await view.grantKnowledge({
          branchId,
          sourceId: proof.sourceId,
          characterId: binding.assetId,
          start: proof.start,
          end: proof.end,
          quote: proof.quote,
          channel: 'persona',
          ownerEpoch: epoch,
          sourceFence,
        });
      }
      await view.setCapability({
        branchId,
        actorId: binding.assetId,
        capability: capability.name,
        status: 'available',
        evidence,
        ownerEpoch: epoch,
        sourceFence,
        data: {
          origin: 'persona',
          assetId: binding.assetId,
          assetRevision: binding.revision,
          level: capability.level ?? null,
        },
      });
    }
  }
  if ((await store.ownerEpoch()) !== epoch)
    throw new StoreError('STALE_WRITE', '角色资料来源已变化，请重新同步');
  result.capabilities = await view.listCapabilities(branchId);
  return result;
}
