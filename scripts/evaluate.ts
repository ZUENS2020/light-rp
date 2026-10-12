import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/server/store';
import type { Evidence, Event, Memory, MemoryProposal, RecallOptions } from '../src/shared/domain';
import { createTestD1 } from '../tests/d1';
import {
  evaluationStories,
  goldQuestions,
  type EvaluationStory,
} from '../tests/fixtures/evaluation-stories';

interface ReplayedStory {
  fixture: EvaluationStory;
  branchId: string;
  forkId: string;
  ids: Record<string, string>;
  events: Map<number, Event>;
  turns: number;
  expectedValues: Record<string, string>;
}
export interface EvaluationResult {
  format: 'lightrp-retrieval-evaluation';
  version: 1;
  timestamp: string;
  dataset: {
    stories: number;
    authoredGoldQuestions: number;
    replayedTurns: number;
    mainStoryTurns: number;
    events: number;
    memories: number;
    singleBranchReplayTurns: number;
    synthetic: true;
  };
  measured: {
    questionPassRate: number;
    questionPasses: number;
    questions: number;
    recallAt5: number;
    mrrAt5: number;
    positiveQuestions: number;
    forbiddenResults: number;
    tokenBudgetViolations: number;
    sourceSpanFailures: number;
    latencyMs: { p50: number; p95: number; max: number };
    degradedQueries: number;
    elapsedMs: number;
  };
  categories: Record<string, { passed: number; total: number }>;
  modelEvaluation: {
    status: 'not-run';
    extractionPrecision: null;
    extractionRecall: null;
    answerAccuracy: null;
    rationale: string;
  };
  results: Array<{
    id: string;
    question: string;
    category: string;
    pass: boolean;
    expected: string[];
    forbidden: string[];
    returned: string[];
    rank: number | null;
    tokens: number;
    elapsedMs: number;
    error?: string;
  }>;
}
const exact = (event: Event, quote = event.text): Evidence => {
  const chars = Array.from(event.text),
    part = Array.from(quote);
  let start = -1;
  for (let offset = 0; offset + part.length <= chars.length; offset++)
    if (chars.slice(offset, offset + part.length).join('') === quote) {
      start = offset;
      break;
    }
  if (start < 0) throw new Error('Fixture evidence does not match its event');
  return { sourceId: event.sourceId, start, end: start + part.length, quote };
};
const percentile = (values: number[], p: number) =>
  values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;

async function replayStory(store: Store, fixture: EvaluationStory): Promise<ReplayedStory> {
  const world = await store.createWorld({ name: fixture.title, description: fixture.setting });
  const story = await store.createStory({ worldId: world.id, name: fixture.title });
  const firstSession = await store.createSession({ branchId: story.branchId, name: '第一幕' });
  const secondSession = await store.createSession({ branchId: story.branchId, name: '续聊第二幕' });
  const ids: Record<string, string> = {},
    events = new Map<number, Event>(),
    expectedValues: Record<string, string> = {};
  const [actorA, actorB] = fixture.actors,
    branchId = story.branchId;
  let procedure: Memory | null = null,
    singleDraft: Memory | null = null;
  for (let round = 1; round <= 64; round++) {
    let content = `第${round}回合：${fixture.setting} ${actorA}与${actorB}核对经过，记录天气、灯光与行程，没有新增关键结论。`;
    let role: 'assistant' | 'user' | 'correction' = 'assistant';
    let viewers = [actorA, actorB],
      speakerId: string | undefined;
    if (round === 1) content = `${fixture.artifact}的标识：${fixture.originalMark}。`;
    if (round === 2) content = `${actorA}与${actorB}约定互相保护，并共同保管${fixture.artifact}。`;
    if (round === 3) content = `真实情况：${fixture.truth}。`;
    if (round === 4) {
      content = `${actorA}目前相信：${fixture.belief}。`;
      role = 'user';
      speakerId = actorA;
      viewers = [actorA];
    }
    if (round === 5) {
      content = `私人秘密：${fixture.secret}。`;
      viewers = [actorA];
    }
    if (round === 6) {
      content = `${fixture.publicClue}；${fixture.privateClue}`;
      viewers = [];
    }
    if (round === 7) content = `队伍驻地：${fixture.oldPlace}。`;
    if (round === 8) {
      content = `作者设定：${actorA}具备${fixture.skill}和临时修补能力。`;
      role = 'correction';
    }
    if (round === 9 || round === 14)
      content = `${actorA}在独立案例${round}成功完成${fixture.skill}：${fixture.steps.join('，')}。`;
    if (round === 10) content = `旧暗号：${fixture.forgotten}。`;
    if (round === 11) content = `私人地址：${fixture.erased}。`;
    if (round === 13) content = `${actorA}仅在这一次成功完成临时修补，没有第二个独立案例。`;
    if (round === 40) content = `队伍驻地变更：${fixture.newPlace}。`;
    if (round === 48) {
      content = `作者纠正${fixture.artifact}的标识：${fixture.correctedMark}。`;
      role = 'correction';
    }
    if (round === 50) content = `主线行动：${fixture.future}。`;
    const appended = await store.appendTurn({
      branchId,
      sessionId: round <= 32 ? firstSession.id : secondSession.id,
      requestId: `${fixture.id}-round-${round}`,
      messages: [{ role, text: content, speakerId, knownBy: viewers, sceneTime: round }],
      scene: { location: round < 40 ? fixture.oldPlace : fixture.newPlace, time: String(round) },
    });
    const event = appended.events[0]!;
    events.set(round, event);
    for (const viewer of viewers)
      await store.grantKnowledge({
        branchId,
        sourceId: event.sourceId,
        characterId: viewer,
        quote: event.text,
        channel: 'witnessed',
      });
    if (round === 6)
      await store.grantKnowledge({
        branchId,
        sourceId: event.sourceId,
        characterId: actorA,
        quote: fixture.publicClue,
        channel: 'told',
      });
    const proposals: MemoryProposal[] = [];
    const fact = (alias: string, fields: Partial<MemoryProposal>, quote = event.text) => {
      const id = `${fixture.id}-${alias}`;
      ids[alias] = id;
      proposals.push({
        id,
        kind: 'canon',
        subject: fixture.artifact,
        predicate: alias,
        value: quote,
        text: quote,
        evidence: [exact(event, quote)],
        knownBy: viewers,
        ...fields,
      });
    };
    if (round === 1) fact('anchor', { predicate: '标识', value: fixture.originalMark });
    if (round === 2)
      fact('relation', { kind: 'relation', subject: actorA, predicate: '互相保护', value: actorB });
    if (round === 3) fact('truth', { predicate: '真实情况', value: fixture.truth });
    if (round === 4)
      fact('belief', {
        kind: 'belief',
        subject: actorA,
        predicate: '当前信念',
        value: fixture.belief,
        observerId: actorA,
        knownBy: [actorA],
      });
    if (round === 5)
      fact('secret', { predicate: '私人秘密', value: fixture.secret, knownBy: [actorA] });
    if (round === 6) {
      fact(
        'public-clue',
        { predicate: '公开线索', value: fixture.publicClue, knownBy: [actorA] },
        fixture.publicClue,
      );
      fact(
        'private-clue',
        { predicate: '密令', value: fixture.privateClue, knownBy: [actorA] },
        fixture.privateClue,
      );
    }
    if (round === 7)
      fact('old-place', {
        subject: fixture.title,
        predicate: '驻地',
        value: fixture.oldPlace,
        validFrom: 1,
        validTo: 40,
      });
    if (round === 10) fact('forgotten', { predicate: '旧暗号', value: fixture.forgotten });
    if (round === 11) fact('erased', { predicate: '私人地址', value: fixture.erased });
    if (round === 40)
      fact('new-place', {
        subject: fixture.title,
        predicate: '驻地',
        value: fixture.newPlace,
        validFrom: 40,
      });
    if (round === 50) fact('parent-future', { predicate: '主线行动', value: fixture.future });
    await store.extract(branchId, {
      eventIds: [event.id],
      proposals,
      cursor: event.seq,
      extractorVersion: 'gold-fixture-v1',
    });
    if (round === 8) {
      await store.setCapability({
        branchId,
        actorId: actorA,
        capability: fixture.skill,
        status: 'available',
        evidence: [exact(event)],
      });
      await store.setCapability({
        branchId,
        actorId: actorA,
        capability: '临时修补',
        status: 'available',
        evidence: [exact(event)],
      });
    }
    if (round === 9 || round === 14) {
      const added = await store.addExperience({
        branchId,
        actorId: actorA,
        capability: fixture.skill,
        conditions: { environment: fixture.id, equipment: '齐备' },
        steps: fixture.steps,
        outcome: 'success',
        evidence: [exact(event)],
      });
      procedure = added.procedure;
    }
    if (round === 13) {
      const added = await store.addExperience({
        branchId,
        actorId: actorA,
        capability: '临时修补',
        conditions: { environment: fixture.id },
        steps: ['检查损坏', '进行临时固定'],
        outcome: 'success',
        evidence: [exact(event)],
      });
      singleDraft = added.procedure;
    }
    if (round === 48) {
      const corrected = await store.correct(branchId, ids.anchor!, {
        text: `标识：${fixture.correctedMark}`,
        value: fixture.correctedMark,
        evidence: [exact(event)],
        validFrom: 1,
      });
      ids.corrected = corrected.id;
    }
  }
  ids.procedure = procedure!.id;
  ids['single-draft'] = singleDraft!.id;
  expectedValues.corrected = fixture.correctedMark;
  const fork = await store.fork({ branchId, atSeq: 32, name: '三十二回合平行线' });
  const forkSession = await store.createSession({ branchId: fork.id, name: '支线第一幕' });
  const alternative = await store.appendTurn({
    branchId: fork.id,
    sessionId: forkSession.id,
    requestId: `${fixture.id}-fork-turn`,
    messages: [
      { role: 'assistant', text: `支线行动：${fixture.alternative}。`, knownBy: [actorA, actorB] },
    ],
  });
  const forkEvent = alternative.events[0]!;
  for (const viewer of [actorA, actorB])
    await store.grantKnowledge({
      branchId: fork.id,
      sourceId: forkEvent.sourceId,
      characterId: viewer,
      quote: forkEvent.text,
      channel: 'witnessed',
    });
  ids.alternative = `${fixture.id}-alternative`;
  await store.extract(fork.id, {
    eventIds: [forkEvent.id],
    proposals: [
      {
        id: ids.alternative,
        kind: 'canon',
        subject: fixture.artifact,
        predicate: '支线行动',
        value: fixture.alternative,
        text: forkEvent.text,
        knownBy: [actorA, actorB],
        evidence: [exact(forkEvent)],
      },
    ],
    cursor: forkEvent.seq,
    extractorVersion: 'gold-fixture-v1',
  });
  await store.forget(branchId, ids.forgotten!, '评测作者明确遗忘');
  await store.deleteSource(events.get(11)!.sourceId, '评测删除私人来源');
  return { fixture, branchId, forkId: fork.id, ids, events, turns: 65, expectedValues };
}

/** Gold extraction candidates are injected, but all validation, writes, permission checks and recalls are real. */
export async function runEvaluation(
  options: { longTurns?: number } = {},
): Promise<EvaluationResult> {
  const longTurns = options.longTurns ?? 500;
  const started = performance.now(),
    fixtureDb = createTestD1();
  try {
    const store = new Store(fixtureDb.db, 'evaluation-author');
    const stories: ReplayedStory[] = [];
    for (const fixture of evaluationStories) stories.push(await replayStory(store, fixture));
    const long = stories[0]!,
      longSession = await store.createSession({ branchId: long.branchId, name: '第五百回合续聊' });
    for (let round = 65; round <= longTurns; round++) {
      const turn = await store.appendTurn({
        branchId: long.branchId,
        sessionId: longSession.id,
        requestId: `long-replay-${round}`,
        messages: [
          {
            role: 'assistant',
            text: `第${round}回合，队伍继续核对灯塔航行日志，保持现有角色、线索和规则。`,
          },
        ],
      });
      await store.extract(long.branchId, {
        eventIds: turn.events.map((e) => e.id),
        proposals: [],
        cursor: turn.events.at(-1)!.seq,
        extractorVersion: 'gold-fixture-v1',
      });
    }
    const otherOwner = new Store(fixtureDb.db, 'other-evaluation-tenant'),
      foreignWorld = await otherOwner.createWorld({ name: '租户乙私有世界' });
    const foreignStory = await otherOwner.createStory({ worldId: foreignWorld.id, name: '租户乙' }),
      foreignSession = await otherOwner.createSession({ branchId: foreignStory.branchId });
    const foreignTurn = await otherOwner.appendTurn({
      branchId: foreignStory.branchId,
      sessionId: foreignSession.id,
      requestId: 'foreign-secret',
      messages: [{ role: 'assistant', text: '租户乙密钥：永不应进入其他租户上下文。' }],
    });
    const foreignMemory = await otherOwner.propose(foreignStory.branchId, {
      id: 'foreign-tenant-memory',
      kind: 'canon',
      subject: '租户乙',
      predicate: '密钥',
      value: '不可越界',
      text: foreignTurn.events[0]!.text,
      evidence: [exact(foreignTurn.events[0]!)],
    });
    const results: EvaluationResult['results'] = [],
      categories: EvaluationResult['categories'] = {},
      latencies: number[] = [];
    let hits = 0,
      positive = 0,
      reciprocal = 0,
      forbiddenResults = 0,
      tokenBudgetViolations = 0,
      sourceSpanFailures = 0,
      degradedQueries = 0;
    for (const gold of goldQuestions) {
      const story = stories.find((item) => item.fixture.id === gold.storyId)!,
        { fixture, ids } = story,
        [actorA, actorB] = fixture.actors;
      let branchId = story.branchId,
        expected: string[] = [],
        forbidden: string[] = [],
        query = gold.text;
      const options: RecallOptions = {
        viewer: 'director',
        maxTokens: 1600,
        maxCandidates: 20,
        graphSeeds: 4,
        maxGraphNodes: 24,
        graphFanout: 4,
        graphHops: 2,
      };
      switch (gold.caseId) {
        case 'early-fact':
          expected = [ids.corrected!];
          forbidden = [ids.anchor!];
          break;
        case 'relationship':
          expected = [ids.relation!];
          options.kinds = ['relation'];
          break;
        case 'truth':
          expected = [ids.truth!];
          options.kinds = ['canon'];
          break;
        case 'belief-owner':
          expected = [ids.belief!];
          options.viewer = actorA;
          options.kinds = ['belief'];
          break;
        case 'belief-other':
          forbidden = [ids.belief!];
          options.viewer = actorB;
          options.kinds = ['belief'];
          options.vectorCandidates = [{ id: ids.belief!, score: 1 }];
          break;
        case 'secret-owner':
          expected = [ids.secret!];
          options.viewer = actorA;
          query = `${fixture.artifact} 私人秘密`;
          break;
        case 'secret-other':
          forbidden = [ids.secret!];
          options.viewer = actorB;
          options.vectorCandidates = [{ id: ids.secret!, score: 1 }];
          break;
        case 'span-grant':
          expected = [ids['public-clue']!];
          forbidden = [ids['private-clue']!];
          options.viewer = actorA;
          options.vectorCandidates = [{ id: ids['private-clue']!, score: 1 }];
          query = `${fixture.artifact} 公开线索 密令`;
          break;
        case 'temporal-before':
          expected = [ids['old-place']!];
          forbidden = [ids['new-place']!];
          options.sceneTime = 20;
          query = `${fixture.title} 驻地`;
          break;
        case 'temporal-after':
          expected = [ids['new-place']!];
          forbidden = [ids['old-place']!];
          options.sceneTime = 50;
          query = `${fixture.title} 驻地`;
          break;
        case 'fork-parent-future':
          branchId = story.forkId;
          forbidden = [ids['parent-future']!, ids.corrected!];
          options.vectorCandidates = [
            { id: ids['parent-future']!, score: 1 },
            { id: ids.corrected!, score: 0.9 },
          ];
          break;
        case 'fork-alternative':
          branchId = story.forkId;
          expected = [ids.alternative!];
          query = `${fixture.artifact} 支线行动`;
          break;
        case 'forgotten':
          forbidden = [ids.forgotten!];
          options.vectorCandidates = [{ id: ids.forgotten!, score: 1 }];
          break;
        case 'erased':
          forbidden = [ids.erased!];
          options.vectorCandidates = [{ id: ids.erased!, score: 1 }];
          break;
        case 'skill-evidence':
          expected = [ids.procedure!];
          forbidden = [ids['single-draft']!];
          options.viewer = actorA;
          options.kinds = ['procedure'];
          options.vectorCandidates = [{ id: ids['single-draft']!, score: 1 }];
          break;
        case 'cross-story-vector': {
          const other = stories.find((item) => item.fixture.id !== fixture.id)!;
          forbidden = [other.ids.secret!, foreignMemory.id];
          options.vectorCandidates = [
            { id: other.ids.secret!, score: 1 },
            { id: foreignMemory.id, score: 0.99 },
          ];
          break;
        }
      }
      const begin = performance.now();
      let returned: string[] = [],
        rank: number | null = null,
        tokens = 0,
        error: string | undefined;
      const previousSpanFailures = sourceSpanFailures;
      try {
        const recalled = await store.recall(branchId, query, options);
        tokens = recalled.tokens;
        returned = recalled.items.map((item) => item.memory.id);
        if (recalled.degraded.length) degradedQueries++;
        if (tokens > options.maxTokens!) tokenBudgetViolations++;
        for (const item of recalled.items)
          for (const evidence of item.evidence) {
            const source = await store.source(evidence.sourceId),
              quote = Array.from(String(source.text)).slice(evidence.start, evidence.end).join('');
            if (quote !== evidence.quote || source.status !== 'active') sourceSpanFailures++;
          }
        if (expected.length) {
          positive++;
          const position = returned.findIndex((id) => expected.includes(id));
          rank = position < 0 ? null : position + 1;
          if (rank !== null && rank <= 5) {
            hits++;
            reciprocal += 1 / rank;
          }
        }
        const goldValues: Record<string, unknown> = {
          'early-fact': fixture.correctedMark,
          relationship: actorB,
          truth: fixture.truth,
          'belief-owner': fixture.belief,
          'secret-owner': fixture.secret,
          'span-grant': fixture.publicClue,
          'temporal-before': fixture.oldPlace,
          'temporal-after': fixture.newPlace,
          'fork-alternative': fixture.alternative,
          'skill-evidence': fixture.steps,
        };
        if (
          expected.length &&
          recalled.items.some(
            (item) =>
              expected.includes(item.memory.id) &&
              JSON.stringify(item.memory.value) !== JSON.stringify(goldValues[gold.caseId]),
          )
        )
          error = 'Gold value mismatch';
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        if (expected.length) positive++;
      }
      const leaked = returned.filter((id) => forbidden.includes(id)).length;
      forbiddenResults += leaked;
      const elapsedMs = performance.now() - begin;
      latencies.push(elapsedMs);
      const pass =
        !error &&
        leaked === 0 &&
        sourceSpanFailures === previousSpanFailures &&
        tokens <= options.maxTokens! &&
        (!expected.length || (rank !== null && rank <= 5));
      const category = categories[gold.category] ?? { passed: 0, total: 0 };
      category.total++;
      if (pass) category.passed++;
      categories[gold.category] = category;
      results.push({
        id: gold.id,
        question: gold.text,
        category: gold.category,
        pass,
        expected,
        forbidden,
        returned,
        rank,
        tokens,
        elapsedMs,
        ...(error ? { error } : {}),
      });
    }
    const counts = fixtureDb.sqlite
      .prepare(
        'SELECT (SELECT count(*) FROM turns) AS turns,(SELECT count(*) FROM events) AS events,(SELECT count(*) FROM memory_versions) AS memories',
      )
      .get() as { turns: number; events: number; memories: number };
    latencies.sort((a, b) => a - b);
    const passes = results.filter((result) => result.pass).length;
    return {
      format: 'lightrp-retrieval-evaluation',
      version: 1,
      timestamp: new Date().toISOString(),
      dataset: {
        stories: stories.length,
        authoredGoldQuestions: goldQuestions.length,
        replayedTurns: counts.turns,
        mainStoryTurns: 64 * stories.length + (longTurns - 64),
        singleBranchReplayTurns: longTurns,
        events: counts.events,
        memories: counts.memories,
        synthetic: true,
      },
      measured: {
        questionPassRate: passes / results.length,
        questionPasses: passes,
        questions: results.length,
        recallAt5: positive ? hits / positive : 0,
        mrrAt5: positive ? reciprocal / positive : 0,
        positiveQuestions: positive,
        forbiddenResults,
        tokenBudgetViolations,
        sourceSpanFailures,
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          max: latencies.at(-1) ?? 0,
        },
        degradedQueries,
        elapsedMs: performance.now() - started,
      },
      categories,
      modelEvaluation: {
        status: 'not-run',
        extractionPrecision: null,
        extractionRecall: null,
        answerAccuracy: null,
        rationale:
          '使用手工合成中文剧情和 gold 候选，调用真实 Store/MemoryEngine 及 SQLite FTS5。没有调用 LLM、真实 Vectorize 或摘要模型；不能将检索回放命中率解释为抽取精确率、自然对话记忆能力或模型回答准确率。',
      },
      results,
    };
  } finally {
    fixtureDb.close();
  }
}

async function main() {
  const args = process.argv.slice(2),
    result = await runEvaluation();
  const outputIndex = args.indexOf('--output'),
    output =
      outputIndex >= 0
        ? args[outputIndex + 1]
        : args.find((arg) => arg.startsWith('--output='))?.slice(9);
  if (output) {
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(result, null, 2));
  }
  process.stdout.write(
    JSON.stringify(
      {
        dataset: result.dataset,
        measured: result.measured,
        categories: result.categories,
        modelEvaluation: result.modelEvaluation,
        failures: result.results.filter((item) => !item.pass),
      },
      null,
      2,
    ) + '\n',
  );
  if (
    result.measured.questionPasses !== result.measured.questions ||
    result.measured.forbiddenResults ||
    result.measured.sourceSpanFailures ||
    result.measured.tokenBudgetViolations
  )
    process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : '评测失败') + '\n');
    process.exitCode = 1;
  });
