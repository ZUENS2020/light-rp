import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env';
import { ApiError } from './errors';
import { analyze, type Extraction } from './extraction';
import type { ContextSnapshot } from './context';
import { branchNamespace, scopeKey } from './context';
import { indexMemories, embed } from './vectors';
import { normalizeCharacter } from '../shared/assets';
import type { Event, Evidence } from '../shared/domain';
import { digest, now, uuid, type Store } from './store';
import { EvaluationStore } from './evaluation';
import { defaults, settingsSchema, type ModelSettings } from './settings';
import {
  extractionQualityCases,
  vectorQualityFacts,
  type ExtractionQualityCase,
  type QualityGold,
} from '../../tests/fixtures/extraction-quality';

const normalize = (value: unknown) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
export interface QualityPrediction {
  category: 'fact' | 'experience' | 'capability';
  kind?: string;
  subject: string;
  value: string;
  name?: string;
  outcome?: string;
  observerId?: string;
  knownBy: string[];
  validFrom?: number;
  validTo?: number;
  level?: string;
  raw: unknown;
}
function predictions(extraction: Extraction): QualityPrediction[] {
  return [
    ...extraction.facts
      .filter((f) => f.kind !== 'episode')
      .map((f) => ({
        category: 'fact' as const,
        kind: f.kind,
        subject: f.subject,
        value: typeof f.value === 'string' ? f.value : JSON.stringify(f.value),
        observerId: f.observerId,
        knownBy: f.knownBy,
        validFrom: f.validFrom,
        validTo: f.validTo,
        raw: f,
      })),
    ...extraction.experiences.map((e) => ({
      category: 'experience' as const,
      subject: e.actorId,
      value: '',
      name: e.capability,
      outcome: e.outcome,
      knownBy: [],
      raw: e,
    })),
    ...extraction.capabilities.map((c) => ({
      category: 'capability' as const,
      subject: c.actorId,
      value: '',
      name: c.name,
      level: c.level,
      knownBy: [],
      raw: c,
    })),
  ];
}
function matches(p: QualityPrediction, g: QualityGold, knowledge = true) {
  return (
    p.category === g.category &&
    (!g.kinds || g.kinds.includes(p.kind ?? '')) &&
    (!g.subjects || g.subjects.map(normalize).includes(normalize(p.subject))) &&
    (!g.valueGroups ||
      g.valueGroups.every((group) =>
        group.some((value) => normalize(p.value).includes(normalize(value))),
      )) &&
    (!g.names || g.names.some((name) => normalize(p.name).includes(normalize(name)))) &&
    (!g.outcomes || g.outcomes.includes(p.outcome ?? '')) &&
    (!g.observerId || p.observerId === g.observerId) &&
    (g.validFrom == null || p.validFrom === g.validFrom) &&
    (g.validTo == null || p.validTo === g.validTo) &&
    (!g.level || normalize(p.level).includes(normalize(g.level))) &&
    (!knowledge ||
      ((!g.requiredKnownBy || g.requiredKnownBy.every((id) => p.knownBy.includes(id))) &&
        (!g.forbiddenKnownBy || g.forbiddenKnownBy.every((id) => !p.knownBy.includes(id)))))
  );
}
/** Unknown predictions remain unjudged. They are never silently credited as correct. */
export function scoreExtractionQuality(
  fixture: ExtractionQualityCase,
  extraction: Extraction | null,
) {
  const matched = new Set<string>();
  const results = extraction
    ? predictions(extraction).map((prediction, index) => {
        const forbidden = fixture.forbidden.find((rule) => matches(prediction, rule));
        if (forbidden)
          return {
            index,
            prediction,
            classification: 'false-positive' as const,
            goldIds: [],
            reason: forbidden.reason,
          };
        const gold = fixture.expected.filter((rule) => matches(prediction, rule));
        if (gold.length) {
          gold.forEach((rule) => matched.add(rule.id));
          return {
            index,
            prediction,
            classification: 'true-positive' as const,
            goldIds: gold.map((rule) => rule.id),
            reason: null,
          };
        }
        const scopeMismatch = fixture.expected.find((rule) => matches(prediction, rule, false));
        if (scopeMismatch)
          return {
            index,
            prediction,
            classification: 'false-positive' as const,
            goldIds: [],
            reason: '事实内容命中 gold，但明确知情范围不匹配',
          };
        return {
          index,
          prediction,
          classification: 'unjudged' as const,
          goldIds: [],
          reason: '没有固定规则匹配；保留原始输出供人工审查',
        };
      })
    : [];
  const calendarViolation =
    !!fixture.forbidCalendarDate &&
    !!extraction &&
    /\d{4}[-年/]\d{1,2}[-月/]\d{1,2}/.test(extraction.scene.time);
  const count = (category?: string) => ({
    tp: results.filter(
      (row) =>
        row.classification === 'true-positive' &&
        (!category || row.prediction.category === category),
    ).length,
    fp: results.filter(
      (row) =>
        row.classification === 'false-positive' &&
        (!category || row.prediction.category === category),
    ).length,
    unjudged: results.filter(
      (row) =>
        row.classification === 'unjudged' && (!category || row.prediction.category === category),
    ).length,
    expected: fixture.expected.filter((rule) => !category || rule.category === category).length,
    matched: fixture.expected.filter(
      (rule) => (!category || rule.category === category) && matched.has(rule.id),
    ).length,
  });
  return {
    predictions: results,
    missingGold: fixture.expected.filter((rule) => !matched.has(rule.id)),
    calendarViolation,
    counts: count(),
    facts: count('fact'),
    experiences: count('experience'),
    capabilities: count('capability'),
    excludedEpisodes: extraction?.facts.filter((f) => f.kind === 'episode').length ?? 0,
  };
}
export function aggregateExtractionQuality(
  rows: { score: ReturnType<typeof scoreExtractionQuality>; error?: unknown }[],
) {
  const metrics = (key: 'counts' | 'facts' | 'experiences' | 'capabilities') => {
    const sum = rows.reduce(
        (acc, row) => {
          const value = row.score[key];
          for (const field of ['tp', 'fp', 'unjudged', 'expected', 'matched'] as const)
            acc[field] += value[field];
          return acc;
        },
        { tp: 0, fp: 0, unjudged: 0, expected: 0, matched: 0 },
      ),
      total = sum.tp + sum.fp + sum.unjudged;
    const precisionLowerBound = total ? sum.tp / total : null,
      precisionUpperBound = total ? (sum.tp + sum.unjudged) / total : null;
    return {
      ...sum,
      judgedPrecision: sum.tp + sum.fp ? sum.tp / (sum.tp + sum.fp) : null,
      precision: sum.unjudged === 0 && total ? sum.tp / total : null,
      precisionLowerBound,
      precisionUpperBound,
      recall: sum.expected ? sum.matched / sum.expected : null,
    };
  };
  const facts = metrics('facts');
  return {
    cases: rows.length,
    failedCases: rows.filter((row) => row.error).length,
    all: metrics('counts'),
    facts,
    experiences: metrics('experiences'),
    capabilities: metrics('capabilities'),
    calendarViolations: rows.filter((row) => row.score.calendarViolation).length,
    factPrecision95Gate:
      facts.precision != null
        ? facts.precision >= 0.95
        : facts.precisionUpperBound != null && facts.precisionUpperBound < 0.95
          ? false
          : null,
    semanticHumanReviewComplete: false,
  };
}
export async function qualityOwner(originOwner: string, runId: string) {
  return `quality-evaluation:${(await digest(originOwner)).slice(0, 24)}:${runId}`;
}
const base = z.object({ runId: z.uuid() });
const payload = base.extend({
  caseId: z.string(),
  settings: settingsSchema.optional(),
  maxModelCalls: z.number().int().min(1).max(3).default(3),
});
const storageKey = async (owner: string, runId: string, name: string) =>
  `quality-evaluation/${await digest(owner)}/${runId}/${name}.json`;
async function isolated(c: { env: Env; get: (name: 'ownerId') => string }, runId: string) {
  return new EvaluationStore(c.env.DB, await qualityOwner(c.get('ownerId'), runId));
}
async function modelConfig(
  c: { env: Env; get: (name: 'ownerId') => string },
  supplied?: ModelSettings,
) {
  const origin = new EvaluationStore(c.env.DB, c.get('ownerId')),
    row = await origin.one<{ data_json: string }>(
      'SELECT data_json FROM model_settings WHERE owner_id=?',
      origin.ownerId,
    ),
    settings =
      supplied ??
      (row ? settingsSchema.parse(JSON.parse(row.data_json)) : defaults(c.env.MODEL_MODE));
  if (settings.mode === 'local-demo')
    throw new ApiError(422, '质量评测只允许实际模型', 'EVALUATION_REAL_MODEL_REQUIRED');
  if (settings.maxOutput < 1024)
    throw new ApiError(422, '实际抽取至少需要1024输出预算', 'EVALUATION_BUDGET');
  return { ...settings, maxOutput: Math.min(settings.maxOutput, 8192) };
}
export function extractionQualityContext(
  fixture: ExtractionQualityCase,
  config: ModelSettings,
  ownerId: string,
): ContextSnapshot {
  const names = fixture.names ?? ['甲', '乙', '丙'];
  const characters = names.map((name, index) => ({
    id: `actor-${['a', 'b', 'c'][index]}`,
    revision: 1,
    data: normalizeCharacter({ name, description: '人工合成评测角色。', personality: '' }),
  }));
  const branch = {
    id: 'quality-synthetic-branch',
    ownerId,
    storyId: 'quality-synthetic-story',
    name: '独立抽取用例',
    parentBranchId: null,
    forkSeq: 0,
    headSeq: 0,
    revision: 0,
    projectionRevision: 0,
    scene: {},
    createdAt: now(),
  };
  const previous = fixture.previous
    ? [
        {
          memory: {
            id: 'fixed-previous',
            memoryKey: 'canon:钥匙:颜色',
            kind: 'canon' as const,
            subject: '钥匙',
            predicate: '颜色',
            value: '红色',
            text: fixture.previous,
            ownerId,
            storyId: branch.storyId,
            branchId: branch.id,
            recordedSeq: 0,
            recordedAt: now(),
            revision: 1,
            status: 'active' as const,
            knownBy: [],
            evidence: [],
            sourceIds: [],
            supersedesId: null,
          },
          score: 1,
          arms: [],
          evidence: [],
        },
      ]
    : [];
  return {
    branch,
    settings: config,
    messages: [],
    ownerEpoch: 0,
    sourceFence: [],
    recall: { items: previous, tokens: 0, visited: 0, truncated: false, degraded: [], cursor: 0 },
    worldbookTriggers: { activated: [], skipped: [], tokens: 0, seed: fixture.id },
    tokens: 0,
    budget: 32768,
    characters,
    resources: [],
    headSeq: 0,
    warnings: [],
    entities: [
      ...characters.map((c) => ({
        id: c.id,
        name: c.data.name,
        kind: 'character' as const,
        aliases: [c.data.name],
        aliasRecords: [{ name: c.data.name, priority: 10 }],
      })),
      ...['钥匙', '天气'].map((name) => ({
        id: name,
        name,
        kind: 'entity' as const,
        aliases: [name],
        aliasRecords: [{ name, priority: 10 }],
      })),
    ],
  } as ContextSnapshot;
}
interface VectorState {
  branchId: string;
  sessionId: string;
  actorA: string;
  actorB: string;
  foreignBranchId: string;
  seeded: number;
  erasedMemoryId?: string;
  erasedSourceId?: string;
  secretMemoryId?: string;
  invalidated?: boolean;
}
async function readState(env: Env, owner: string, runId: string) {
  const value = await env.BUCKET.get(await storageKey(owner, runId, 'vector-state'));
  if (!value) throw new ApiError(409, '先创建向量评测资料', 'EVALUATION_SETUP');
  return await value.json<VectorState>();
}
const exact = (event: Event): Evidence => ({
  sourceId: event.sourceId,
  start: 0,
  end: Array.from(event.text).length,
  quote: event.text,
});
async function grantFixtureEvent(store: Store, branchId: string, event: Event, actors: string[]) {
  for (const characterId of actors)
    await store.grantKnowledge({
      branchId,
      characterId,
      sourceId: event.sourceId,
      start: 0,
      end: Array.from(event.text).length,
      quote: event.text,
      channel: 'witnessed',
    });
}
async function writeState(env: Env, owner: string, runId: string, state: VectorState) {
  await env.BUCKET.put(await storageKey(owner, runId, 'vector-state'), JSON.stringify(state));
}
/** Instrument only binding calls; never intercept global fetch or collect request credentials. */
function embeddingBudget(env: Env, max: number) {
  let calls = 0;
  const ai = new Proxy(env.AI, {
    get(target, key) {
      if (key === 'run')
        return (...args: unknown[]) => {
          if (calls >= max)
            throw new ApiError(429, '达到明确 embedding 调用预算', 'EVALUATION_BUDGET');
          calls++;
          return Reflect.apply(target.run, target, args);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, AI: ai } as Env, calls: () => calls };
}
export const qualityEvaluationRouter = new Hono<AppEnv>();
qualityEvaluationRouter.use('*', async (c, next) => {
  if (c.env.AUTH_MODE !== 'local' && !c.get('ownerId').startsWith('service:'))
    throw new ApiError(403, '质量评测仅允许本地或验证服务身份', 'FORBIDDEN');
  await next();
});
qualityEvaluationRouter.get('/manifest', async (c) =>
  c.json({
    format: 'lightrp-quality-gold',
    version: 1,
    extractionCases: extractionQualityCases,
    vectorFacts: vectorQualityFacts,
    goldDigest: await digest({ extractionQualityCases, vectorQualityFacts }),
    synthetic: true,
    methodology:
      '固定人工规则匹配结构化值、归属、结果和明确知情范围；不把未匹配的预测判为正确，episode不计入原子事实precision。',
  }),
);
qualityEvaluationRouter.post('/extraction', async (c) => {
  const body = payload.parse(await c.req.json()),
    fixture = extractionQualityCases.find((f) => f.id === body.caseId);
  if (!fixture) throw new ApiError(404, '抽取评测案例不存在', 'NOT_FOUND');
  const store = await isolated(c, body.runId),
    config = await modelConfig(c, body.settings),
    context = extractionQualityContext(fixture, config, store.ownerId),
    attempts: unknown[] = [],
    usage: unknown[] = [];
  let calls = 0,
    extraction: Extraction | null = null,
    error: unknown = null;
  const started = performance.now();
  try {
    extraction = await analyze(
      c.env,
      context,
      { mode: fixture.mode, text: fixture.user },
      fixture.assistant,
      {
        onAttempt: (event) => {
          if (event.phase === 'start') {
            if (calls >= body.maxModelCalls)
              throw new ApiError(429, '达到抽取调用预算', 'EVALUATION_BUDGET');
            calls++;
          }
          attempts.push(event);
        },
        onUsage: (value, attempt) => usage.push({ attempt, ...value }),
      },
    );
  } catch (value) {
    error = {
      code: value instanceof ApiError ? value.code : 'EXTRACTION_FAILURE',
      status: value instanceof ApiError ? value.status : 500,
    };
  }
  const result = {
    id: fixture.id,
    category: fixture.category,
    synthetic: true,
    goldDigest: await digest(fixture),
    fixture,
    extraction,
    rawModelAttempts: attempts,
    usage,
    error,
    modelCalls: calls,
    elapsedMs: performance.now() - started,
    score: scoreExtractionQuality(fixture, extraction),
    model: {
      mode: config.mode,
      provider: config.provider,
      model: config.model,
      auxiliaryModel: config.auxiliaryModel || null,
    },
    actualCostUSD: null,
  };
  await c.env.BUCKET.put(
    await storageKey(store.ownerId, body.runId, fixture.id),
    JSON.stringify(result),
  );
  return c.json(result);
});
qualityEvaluationRouter.post('/vector/setup', async (c) => {
  const { runId } = base.parse(await c.req.json()),
    store = await isolated(c, runId),
    existing = await c.env.BUCKET.get(await storageKey(store.ownerId, runId, 'vector-state'));
  if (existing) return c.json(await existing.json<VectorState>());
  const world = await store.createWorld({ name: '真实向量评测 · 固定合成事实' }),
    actorA = uuid(),
    actorB = uuid(),
    at = now();
  for (const [id, name] of [
    [actorA, '甲'],
    [actorB, '乙'],
  ]) {
    const raw = JSON.stringify({ name }),
      data = JSON.stringify(normalizeCharacter({ name }));
    await store.batch([
      {
        sql: 'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
        params: [id, store.ownerId, 'character', name, raw, data, at, at],
      },
      {
        sql: 'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,1,?,?,?)',
        params: [uuid(), id, raw, data, at],
      },
    ]);
  }
  const story = await store.createStory({
      worldId: world.id,
      name: '单独向量语料分支',
      characterIds: [actorA, actorB],
    }),
    session = await store.createSession({ branchId: story.branchId }),
    foreign = await store.createStory({ worldId: world.id, name: '不可跨入的空白分支' });
  const state: VectorState = {
    branchId: story.branchId,
    sessionId: session.id,
    actorA,
    actorB,
    foreignBranchId: foreign.branchId,
    seeded: 0,
  };
  await writeState(c.env, store.ownerId, runId, state);
  return c.json(state, 201);
});
qualityEvaluationRouter.post('/vector/seed', async (c) => {
  const body = base
    .extend({ from: z.number().int().min(0).max(19), to: z.number().int().min(0).max(19) })
    .parse(await c.req.json());
  if (body.to < body.from || body.to - body.from > 3)
    throw new ApiError(400, '每次最多提交4条向量语料');
  const store = await isolated(c, body.runId),
    state = await readState(c.env, store.ownerId, body.runId);
  if (body.from > state.seeded) throw new ApiError(409, '语料按固定顺序提交', 'EVALUATION_SETUP');
  for (let index = body.from; index <= body.to; index++) {
    const fact = vectorQualityFacts[index]!,
      id = `${body.runId}:quality:${fact.id}`,
      turn = await store.appendTurn({
        branchId: state.branchId,
        sessionId: state.sessionId,
        requestId: id,
        messages: [{ role: 'assistant', text: fact.text, knownBy: [state.actorA, state.actorB] }],
      });
    await grantFixtureEvent(store, state.branchId, turn.events[0]!, [state.actorA, state.actorB]);
    await store.propose(state.branchId, {
      id,
      kind: 'canon',
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      text: fact.text,
      evidence: [exact(turn.events[0]!)],
      knownBy: [state.actorA, state.actorB],
    });
    state.seeded = Math.max(state.seeded, index + 1);
  }
  await writeState(c.env, store.ownerId, body.runId, state);
  return c.json({ seeded: state.seeded, total: vectorQualityFacts.length });
});
qualityEvaluationRouter.post('/vector/extras', async (c) => {
  const { runId } = base.parse(await c.req.json()),
    store = await isolated(c, runId),
    state = await readState(c.env, store.ownerId, runId);
  if (state.seeded !== 20) throw new ApiError(409, '先完成20条固定语料', 'EVALUATION_SETUP');
  for (let index = 0; index < 8; index++) {
    const id = `${runId}:distractor:${index}`,
      text = `第${index + 1}号航船今天停靠星港，船员正在清点工具和早餐。`;
    const turn = await store.appendTurn({
      branchId: state.branchId,
      sessionId: state.sessionId,
      requestId: id,
      messages: [{ role: 'assistant', text, knownBy: [state.actorA, state.actorB] }],
    });
    await grantFixtureEvent(store, state.branchId, turn.events[0]!, [state.actorA, state.actorB]);
    await store.propose(state.branchId, {
      id,
      kind: 'episode',
      subject: `航船${index + 1}`,
      predicate: '清点',
      value: '工具和早餐',
      text,
      evidence: [exact(turn.events[0]!)],
      knownBy: [state.actorA, state.actorB],
    });
  }
  for (const [kind, text] of [
    ['secret', '只有甲知道私人暗门口令是青鸦。'],
    ['erase', '旧暗门的独立备用口令是白鹿。'],
  ]) {
    const id = `${runId}:quality:${kind}`,
      turn = await store.appendTurn({
        branchId: state.branchId,
        sessionId: state.sessionId,
        requestId: id,
        messages: [
          {
            role: 'assistant',
            text,
            knownBy: kind === 'secret' ? [state.actorA] : [state.actorA, state.actorB],
          },
        ],
      });
    await grantFixtureEvent(
      store,
      state.branchId,
      turn.events[0]!,
      kind === 'secret' ? [state.actorA] : [state.actorA, state.actorB],
    );
    const memory = await store.propose(state.branchId, {
      id,
      kind: 'canon',
      subject: kind === 'secret' ? '私人暗门' : '旧暗门',
      predicate: '口令',
      value: kind === 'secret' ? '青鸦' : '白鹿',
      text,
      evidence: [exact(turn.events[0]!)],
      knownBy: kind === 'secret' ? [state.actorA] : [state.actorA, state.actorB],
    });
    if (kind === 'secret') state.secretMemoryId = memory.id;
    else {
      state.erasedMemoryId = memory.id;
      state.erasedSourceId = turn.events[0]!.sourceId;
    }
  }
  await writeState(c.env, store.ownerId, runId, state);
  return c.json({ facts: 20, distractors: 8, negativeSources: 2 });
});
qualityEvaluationRouter.post('/vector/index', async (c) => {
  const body = base
      .extend({ maxEmbeddingCalls: z.number().int().min(1).max(10).default(10) })
      .parse(await c.req.json()),
    store = await isolated(c, body.runId),
    state = await readState(c.env, store.ownerId, body.runId);
  if (!state.erasedMemoryId)
    throw new ApiError(409, '先完成固定语料与干扰条目', 'EVALUATION_SETUP');
  const bounded = embeddingBudget(c.env, body.maxEmbeddingCalls),
    started = performance.now();
  await indexMemories(bounded.env, store, state.branchId);
  const manifest = await store.all(
    'SELECT vector_id,memory_id,viewer FROM vector_manifest WHERE owner_id=? AND branch_id=?',
    store.ownerId,
    state.branchId,
  );
  return c.json({
    embeddingModel: '@cf/baai/bge-m3',
    dimension: 1024,
    embeddingCalls: bounded.calls(),
    elapsedMs: performance.now() - started,
    vectors: manifest,
  });
});
qualityEvaluationRouter.post('/vector/invalidate', async (c) => {
  const { runId } = base.parse(await c.req.json()),
    store = await isolated(c, runId),
    state = await readState(c.env, store.ownerId, runId);
  if (!state.erasedSourceId) throw new ApiError(409, '未创建删除案例', 'EVALUATION_SETUP');
  await store.deleteSource(state.erasedSourceId);
  state.invalidated = true;
  await writeState(c.env, store.ownerId, runId, state);
  return c.json({ deletedMemoryId: state.erasedMemoryId, staleIndexIntentionallyKept: true });
});
export async function queryQualityVector(
  env: Env,
  store: Store,
  state: VectorState,
  runId: string,
  id: string,
) {
  const stage = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      console.error(
        JSON.stringify({
          event: 'quality_vector_error',
          stage: name,
          errorType: error instanceof Error ? error.name : 'UNKNOWN',
        }),
      );
      throw new ApiError(502, `真实向量评测的${name}步骤失败`, `EVALUATION_VECTOR_${name}`);
    }
  };
  const readiness = id.startsWith('ready-'),
    lookup = readiness ? id.slice(6) : id,
    fact = vectorQualityFacts.find((f) => f.id === lookup);
  if (
    !fact &&
    !['secret-other', 'erased', 'erased-before', 'cross-branch', 'secret-owner'].includes(id)
  )
    throw new ApiError(404, '向量问题不存在', 'NOT_FOUND');
  const viewer =
      id === 'secret-other' ? state.actorB : id === 'secret-owner' ? state.actorA : 'director',
    branchId = id === 'cross-branch' ? state.foreignBranchId : state.branchId,
    query =
      (readiness ? fact?.text : fact?.query) ??
      (['erased', 'erased-before'].includes(id)
        ? '旧暗门的独立备用口令是什么？'
        : '私人暗门的秘密口令是什么？'),
    expected = fact
      ? `${runId}:quality:${fact.id}`
      : id === 'secret-owner'
        ? state.secretMemoryId
        : id === 'erased-before'
          ? state.erasedMemoryId
          : null;
  const start = performance.now(),
    encoded = await stage('EMBEDDING', () => embed(env, [query])),
    namespace = await branchNamespace(store.ownerId, branchId),
    scope = await scopeKey(store.ownerId, branchId, viewer),
    matches = await stage('QUERY', () =>
      env.VECTORS.query(encoded[0]!, {
        topK: 10,
        namespace,
        filter: { scope },
        returnValues: false,
        returnMetadata: 'none',
      }),
    );
  const rows = await stage('MANIFEST', () =>
      store.all<{ vector_id: string; memory_id: string }>(
        'SELECT vector_id,memory_id FROM vector_manifest WHERE owner_id=? AND branch_id=? AND viewer=? AND scope=? AND vector_id IN (SELECT value FROM json_each(?))',
        store.ownerId,
        branchId,
        viewer,
        scope,
        JSON.stringify(matches.matches.map((match) => match.id)),
      ),
    ),
    mapping = new Map(rows.map((row) => [row.vector_id, row.memory_id])),
    allowed = new Map(
      (await stage('SOURCE_ACL', () => store.memories(branchId, { viewer, limit: 1000 }))).map(
        (memory) => [memory.id, memory],
      ),
    );
  const verified = matches.matches.map((match) => ({
      vectorId: match.id,
      memoryId: mapping.get(match.id) ?? null,
      score: match.score,
    })),
    accepted = verified.filter((match) => match.memoryId && allowed.has(match.memoryId)),
    rejected = verified.filter((match) => !match.memoryId || !allowed.has(match.memoryId)),
    rank = expected ? accepted.findIndex((match) => match.memoryId === expected) + 1 : null;
  const forbidden = [
      ...(state.invalidated ? [state.erasedMemoryId] : []),
      ...(viewer === state.actorB ? [state.secretMemoryId] : []),
    ].filter(Boolean),
    violations = accepted.filter((match) => forbidden.includes(match.memoryId!));
  const hybrid = await stage('HYBRID', () =>
    store.recall(branchId, query, {
      viewer,
      maxTokens: 8000,
      maxCandidates: 120,
      vectorCandidates: accepted.map((match) => ({ id: match.memoryId!, score: match.score })),
    }),
  );
  return {
    id,
    query,
    viewer,
    branchId,
    expectedMemoryId: expected,
    rawVectorMatches: verified,
    accepted,
    rejected,
    rank: rank && rank > 0 ? rank : null,
    hitAt10: expected ? !!rank && rank > 0 : null,
    hybridHitAt10: expected
      ? hybrid.items.slice(0, 10).some((item) => item.memory.id === expected)
      : null,
    forbiddenResults: violations,
    negativePass: !expected
      ? id === 'erased' && !verified.some((match) => match.memoryId === state.erasedMemoryId)
        ? null
        : violations.length === 0 && !(id === 'cross-branch' && accepted.length)
      : null,
    staleDeletedVectorObserved:
      id === 'erased' ? verified.some((match) => match.memoryId === state.erasedMemoryId) : null,
    embeddingCalls: 1,
    embeddingModel: '@cf/baai/bge-m3',
    dimension: 1024,
    elapsedMs: performance.now() - start,
  };
}
qualityEvaluationRouter.post('/vector/query', async (c) => {
  const body = base.extend({ id: z.string() }).parse(await c.req.json()),
    store = await isolated(c, body.runId),
    state = await readState(c.env, store.ownerId, body.runId);
  return c.json(await queryQualityVector(c.env, store, state, body.runId, body.id));
});
