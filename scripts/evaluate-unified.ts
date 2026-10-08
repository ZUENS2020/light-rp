import { writeFile, mkdir } from 'node:fs/promises';
import { runEvaluation } from './evaluate';
import { evaluationStories } from '../tests/fixtures/evaluation-stories';
import { createTestD1 } from '../tests/d1';
import { Store } from '../src/server/store';
import { applyThreadChanges, plotThreads, beginUnified } from '../src/server/narrative-memory';

// Authored synthetic questions test cooperation in addition to the existing 128 retrieval cases.
// No language-model quality or Cloudflare latency is inferred from this local replay.
const base = await runEvaluation({ longTurns: 5000 });
const d = createTestD1(),
  s = new Store(d.db, 'evaluation:unified-coordination');
const results: { story: string; question: string; pass: boolean }[] = [];
try {
  for (const fixture of evaluationStories) {
    const world = await s.createWorld(fixture.title),
      story = await s.createStory({ worldId: world.id }),
      branchId = story.branchId,
      session = await s.createSession({ branchId });
    const e = (
      await s.appendTurn({
        branchId,
        sessionId: session.id,
        requestId: `${fixture.id}:promise`,
        messages: [
          { role: 'assistant', text: `${fixture.actors[0]}承诺归还${fixture.artifact}。` },
        ],
      })
    ).events[0]!;
    const change = {
      title: `归还${fixture.artifact}`,
      type: 'promise' as const,
      state: 'open' as const,
      completion: `交还${fixture.artifact}`,
      text: e.text,
      evidence: [{ source: 'assistant' as const, quote: e.text }],
      knowledge: [],
    };
    await applyThreadChanges(s, branchId, { threadChanges: [change] }, [e], await s.ownerEpoch());
    await applyThreadChanges(s, branchId, { threadChanges: [change] }, [e], await s.ownerEpoch());
    const thread = (await plotThreads(s, branchId))[0]!;
    results.push({
      story: fixture.id,
      question: '同一承诺重复整理是否仍只有一条线程？',
      pass: (await plotThreads(s, branchId)).length === 1,
    });
    const child = await s.fork({ branchId, atSeq: e.seq });
    const end = (
      await s.appendTurn({
        branchId,
        sessionId: session.id,
        requestId: `${fixture.id}:result`,
        messages: [{ role: 'assistant', text: `${fixture.artifact}已经交还，目标完成。` }],
      })
    ).events[0]!;
    await applyThreadChanges(
      s,
      branchId,
      {
        threadChanges: [
          {
            ...change,
            threadId: thread.id,
            state: 'resolved',
            text: end.text,
            evidence: [{ source: 'assistant', quote: end.text }],
          },
        ],
      },
      [end],
      await s.ownerEpoch(),
    );
    results.push({
      story: fixture.id,
      question: '父分支结案后，分叉前的承诺是否仍未完成？',
      pass: (await plotThreads(s, child.id))[0]?.state === 'open',
    });
    results.push({
      story: fixture.id,
      question: '目标完成是否不会新增能力和技能成功？',
      pass:
        (await s.memories(branchId, { kinds: ['experience', 'procedure'] })).length === 0 &&
        (await s.listCapabilities(branchId)).length === 0,
    });
    await s.deleteSource(e.sourceId);
    results.push({
      story: fixture.id,
      question: '删除承诺原文后，继承它的子分支能否继续召回？',
      pass: (await plotThreads(s, child.id)).length === 0,
    });
  }
} finally {
  d.close();
}
const report = {
  format: 'lightrp-unified-coordination-evaluation',
  timestamp: new Date().toISOString(),
  dataset: {
    stories: 8,
    goldQuestions: base.measured.questions + results.length,
    singleBranchReplayTurns: base.dataset.singleBranchReplayTurns,
    synthetic: true,
  },
  retrieval: base,
  cooperation: results,
  passed: base.measured.questions === base.measured.questionPasses && results.every((r) => r.pass),
  modelQuality: {
    status: 'not-run',
    extractionPrecision: null,
    evidenceRecallAt10: null,
    reason: '确定性回放使用已标注事实与线程候选；真实抽取、叙事和语义质量需运行预览模型评测。',
  },
};
await mkdir('reports', { recursive: true });
await writeFile('reports/unified-memory-evaluation.json', JSON.stringify(report, null, 2));
process.stdout.write(
  JSON.stringify(
    {
      dataset: report.dataset,
      retrieval: base.measured,
      cooperationPasses: results.filter((r) => r.pass).length,
      passed: report.passed,
    },
    null,
    2,
  ) + '\n',
);
if (!report.passed) process.exitCode = 1;
