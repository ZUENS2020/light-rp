import { expect, it } from 'vitest';
import {
  auditExtractionKnowledge,
  explicitKnowledgeNegations,
} from '../scripts/quality-knowledge-audit';
import { aggregateVectorQuality } from '../scripts/quality-evaluate';
import { vectorQualityFacts, extractionQualityCases } from './fixtures/extraction-quality';
import { reaggregateQualityReport } from '../scripts/reaggregate-quality';
import { scoreExtractionQuality } from '../src/server/extraction-evaluation';

it('uses explicit unchanged original negation as an independent knowledge audit', () => {
  for (const rule of explicitKnowledgeNegations)
    expect(extractionQualityCases.find((row) => row.id === rule.caseId)?.assistant).toContain(
      rule.quote,
    );
});
it('recomputes derived summaries without changing raw attempts, gold or originals', () => {
  const fixture = extractionQualityCases[0]!,
    row = {
      id: fixture.id,
      extraction: null,
      error: { code: 'MODEL_HTTP' },
      score: scoreExtractionQuality(fixture, null),
      rawModelAttempts: [{ phase: 'start' }],
      usage: [],
      fixture,
    };
  const report = {
      format: 'lightrp-real-model-quality',
      status: 'completed',
      extractionResults: [row],
      usage: [],
      vectorResults: [],
      plan: { extractionCases: 1, positiveVectorQuestions: 0 },
      measured: { extraction: { facts: { recall: 0 } } },
    },
    original = JSON.stringify(report);
  const derived = reaggregateQualityReport(report);
  expect(JSON.stringify(report)).toBe(original);
  expect(derived.extractionResults).toEqual(report.extractionResults);
  expect(derived).toMatchObject({
    status: 'transport-failed',
    measured: {
      extraction: null,
      extractionEndToEnd: { attemptedCases: 1, facts: { expected: 1, matched: 0, recall: 0 } },
    },
  });
  expect(derived.derivedStatisticsAudit.rawResultsSha256).toHaveLength(64);
});
it('does not hide forbidden knowledge in episodes, even if the server rejects the candidate', () => {
  const candidate = {
    kind: 'episode',
    subject: 'actor-b',
    text: '乙记住钥匙在仓库。',
    value: '钥匙在仓库',
    knownBy: ['actor-b', 'actor-c'],
    evidence: [],
  };
  const output = { facts: [candidate], experiences: [], capabilities: [] };
  const audit = auditExtractionKnowledge([
    {
      id: 'q04-told',
      error: { code: 'EXTRACTION_INVALID' },
      extraction: null,
      rawModelAttempts: [{ attempt: 1, phase: 'response', rawOutput: JSON.stringify(output) }],
    },
  ]);
  expect(audit.acceptedViolationCount).toBe(0);
  expect(audit.rawAttemptViolationCount).toBe(1);
  expect(audit.rawAttemptViolations[0]).toMatchObject({
    kind: 'episode',
    forbiddenActors: ['actor-c'],
    candidate,
  });
});
it('audits accepted episodes while preserving allowed adjacent visible facts', () => {
  const safe = {
      kind: 'canon',
      subject: '钥匙',
      value: '仓库',
      knownBy: ['actor-b'],
      evidence: [{ quote: extractionQualityCases[16]!.assistant }],
      knowledge: [{ actorId: 'actor-b', quote: extractionQualityCases[16]!.assistant }],
    },
    unsafe = { kind: 'episode', value: '甲的子夜东桥秘密计划', knownBy: ['actor-b', 'actor-c'] };
  const audit = auditExtractionKnowledge([
    { id: 'q17-selective', extraction: { facts: [safe, unsafe] } },
  ]);
  expect(audit.acceptedViolationCount).toBe(1);
  expect(audit.acceptedViolations[0]).toMatchObject({
    index: 1,
    forbiddenActors: ['actor-b', 'actor-c'],
  });
});
it('does not interpret partial non-JSON output or a missing response as proven safety', () => {
  const audit = auditExtractionKnowledge([
    { id: 'q04-told', rawModelAttempts: [{ phase: 'truncated', rawOutput: '{"facts":[' }] },
  ]);
  expect(audit.unparseableAttempts).toHaveLength(1);
  expect(audit.acceptedCandidates).toBe(0);
  expect(audit.note).toContain('未返回不证明授权正确');
});
it('also checks experience and capability knowledge proofs without relying on a knownBy field', () => {
  const audit = auditExtractionKnowledge([
    {
      id: 'q04-told',
      extraction: {
        experiences: [
          { capability: '记住钥匙在仓库', knowledge: [{ actorId: 'actor-c', quote: '错误获知' }] },
        ],
        capabilities: [
          { name: '钥匙在仓库的知识', knowledge: [{ actorId: 'actor-c', quote: '错误获知' }] },
        ],
      },
    },
  ]);
  expect(audit.acceptedViolationCount).toBe(2);
  expect(audit.acceptedViolations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ category: 'experiences' }),
      expect.objectContaining({ category: 'capabilities' }),
    ]),
  );
});
it('requires unique fixed vector IDs and genuinely measured negatives', () => {
  const positives = vectorQualityFacts.map((row) => ({
    id: row.id,
    hitAt10: true,
    hybridHitAt10: true,
  }));
  expect(aggregateVectorQuality(positives).vectorRecall90Gate).toBe(true);
  const duplicate = aggregateVectorQuality([...positives.slice(0, 19), positives[0]!]);
  expect(duplicate.vectorRecall90Gate).toBe(null);
  expect(duplicate.duplicatePositiveIds).toEqual([positives[0]!.id]);
  expect(
    aggregateVectorQuality([...positives, { id: 'not-fixed', hitAt10: true }]).vectorRecall90Gate,
  ).toBe(null);
  expect(aggregateVectorQuality([{ id: 'secret-other', error: 'HTTP failed' }])).toMatchObject({
    negativeMeasured: 0,
    negativePassed: 0,
    forbiddenResults: 0,
  });
  expect(
    aggregateVectorQuality([
      ...positives.slice(0, 19),
      { id: positives[19]!.id, error: 'HTTP failed' },
    ]).vectorRecall90Gate,
  ).toBe(null);
});
