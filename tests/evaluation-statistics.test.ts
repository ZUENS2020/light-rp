import { describe, expect, it } from 'vitest';
import { summarizeLiveResults } from '../scripts/live-evaluate';
import {
  aggregateExtractionQuality,
  scoreExtractionQuality,
  summarizeExtractionAttempts,
  type ExtractionQualityResult,
} from '../src/server/extraction-evaluation';
import { extractionSchema } from '../src/server/extraction';
import { evaluationCase, scoreEvaluationAnswer } from '../src/server/evaluation';
import { extractionQualityCases, type ExtractionQualityCase } from './fixtures/extraction-quality';
import { evaluationStories } from './fixtures/evaluation-stories';

// These are authored examples for the arithmetic tests, constructed before any model output.
// Their scores still pass through the production fixed-rule scorer.
function acceptedResult(fixture: ExtractionQualityCase): ExtractionQualityResult {
  const evidence = [{ source: 'assistant', quote: fixture.assistant }],
    extraction = extractionSchema.parse({
      scene: {},
      facts: fixture.expected
        .filter((gold) => gold.category === 'fact')
        .map((gold) => ({
          kind: gold.kinds?.[0] ?? 'canon',
          subject: gold.subjects?.[0] ?? 'actor-a',
          predicate: '测试属性',
          value: gold.valueGroups?.map((group) => group[0]).join(' ') ?? '',
          text: fixture.assistant,
          knownBy: gold.requiredKnownBy ?? [],
          observerId: gold.observerId,
          validFrom: gold.validFrom,
          validTo: gold.validTo,
          evidence,
        })),
      experiences: fixture.expected
        .filter((gold) => gold.category === 'experience')
        .map((gold) => ({
          actorId: gold.subjects?.[0] ?? 'actor-a',
          capability: gold.names?.[0] ?? '开锁',
          conditions: {},
          steps: ['实际执行步骤'],
          outcome: gold.outcomes?.[0] ?? 'unknown',
          evidence,
        })),
      capabilities: fixture.expected
        .filter((gold) => gold.category === 'capability')
        .map((gold) => ({
          actorId: gold.subjects?.[0] ?? 'actor-a',
          name: gold.names?.[0] ?? '开锁',
          level: gold.level ?? '初级',
          evidence,
        })),
    });
  return {
    id: fixture.id,
    extraction,
    error: null,
    rawModelAttempts: [{ phase: 'response' }],
    score: scoreExtractionQuality(fixture, extraction),
  };
}

describe('fixed extraction corpus statistics', () => {
  it('requires all 20 unique cases with accepted complete outputs before evaluating the precision gate', () => {
    const rows = extractionQualityCases.map(acceptedResult);
    expect(aggregateExtractionQuality(rows)).toMatchObject({
      cases: 20,
      acceptedCases: 20,
      factPrecision95Gate: true,
      coverage: { fullFixedCorpus: true, uniqueCases: 20 },
      facts: { precision: 1, recall: 1 },
      semanticHumanReviewComplete: false,
    });
    for (const incomplete of [
      rows.slice(0, 1),
      rows.slice(0, 19),
      Array.from({ length: 20 }, () => rows[0]!),
      rows.map((row, index) => (index === 0 ? { ...row, id: 'not-fixed-gold' } : row)),
      rows.map((row, index) => (index === 0 ? { ...row, error: { code: 'MODEL_HTTP' } } : row)),
      rows.map((row, index) => (index === 0 ? { ...row, extraction: null } : row)),
      rows.map((row, index) =>
        index === 0 ? { ...row, rawModelAttempts: [{ phase: 'truncated' }] } : row,
      ),
    ])
      expect(aggregateExtractionQuality(incomplete).factPrecision95Gate).toBeNull();
  });

  it('does not credit unjudged predictions or turn an incomplete failing probe into a full gate', () => {
    const rows = extractionQualityCases.map(acceptedResult),
      extra = {
        kind: 'canon' as const,
        subject: '钥匙',
        predicate: '材料',
        value: '铜',
        text: '没有人工规则判断这个预测',
        knownBy: [],
        evidence: [{ source: 'assistant' as const, quote: extractionQualityCases[0]!.assistant }],
      };
    const unknown = extractionSchema.parse({
      ...rows[0]!.extraction,
      facts: [...rows[0]!.extraction!.facts, extra],
    });
    rows[0] = {
      ...rows[0]!,
      extraction: unknown,
      score: scoreExtractionQuality(extractionQualityCases[0]!, unknown),
    };
    const metrics = aggregateExtractionQuality(rows);
    expect(metrics.facts.unjudged).toBe(1);
    expect(metrics.facts.precision).toBeNull();
    expect(metrics.factPrecision95Gate).toBeNull();
    const lieFixture = extractionQualityCases[1]!,
      lie = extractionSchema.parse({
        ...rows[1]!.extraction,
        facts: [
          ...rows[1]!.extraction!.facts,
          ...Array.from({ length: 4 }, () => ({ ...extra, predicate: '位置', value: '仓库' })),
        ],
      });
    rows[1] = { ...rows[1]!, extraction: lie, score: scoreExtractionQuality(lieFixture, lie) };
    expect(aggregateExtractionQuality(rows).factPrecision95Gate).toBe(false);
    expect(aggregateExtractionQuality([rows[1]!]).factPrecision95Gate).toBeNull();
  });

  it('includes HTTP failures and truncated/unaccepted outputs in end-to-end gold recall', () => {
    const good = acceptedResult(extractionQualityCases[0]!),
      failure = {
        id: extractionQualityCases[1]!.id,
        score: scoreExtractionQuality(extractionQualityCases[1]!, null),
        error: { code: 'MODEL_HTTP' },
      };
    expect(aggregateExtractionQuality([good]).facts.recall).toBe(1);
    expect(summarizeExtractionAttempts([good, failure])).toMatchObject({
      attemptedCases: 2,
      acceptedCases: 1,
      failedCases: 1,
      unavailableCases: 1,
      facts: { expected: 3, matched: 1, recall: 1 / 3 },
      fullFixedCorpus: false,
    });
    // Even if a failed response carries a stale successful score, it is not an accepted result.
    const stale = {
      ...acceptedResult(extractionQualityCases[1]!),
      error: { code: 'OUTPUT_TRUNCATED' },
    };
    expect(summarizeExtractionAttempts([good, stale]).facts.recall).toBe(1 / 3);
    expect(summarizeExtractionAttempts([good, { ...good }]).facts.recall).toBeNull();
    expect(summarizeExtractionAttempts([{ ...good, id: 'unknown-case' }]).facts.recall).toBeNull();
  });
});

function liveResult(
  storyIndex: number,
  caseId: string,
  answer?: { answer: string; facts: string[]; unknown: boolean; citations: string[] },
) {
  const fixture = evaluationStories[storyIndex]!,
    test = evaluationCase(
      { fixture, branchId: '', forkId: '', ids: {}, events: new Map() },
      caseId,
      '',
    ),
    resultAnswer = answer ?? {
      answer: test.expectedClaims.join('；'),
      facts: test.expectedClaims,
      unknown: test.unknown ?? false,
      citations: ['authorized-source'],
    },
    metrics = scoreEvaluationAnswer(
      resultAnswer,
      test.expectedClaims,
      test.forbiddenClaims,
      test.unknown,
    );
  return {
    id: test.gold.id,
    category: test.gold.category,
    strategy: 'hybrid',
    answer: resultAnswer,
    schemaValid: true,
    metrics: {
      ...metrics,
      citationViolations: [],
      leakage: test.forbiddenClaims.length ? metrics.leakedClaims.length > 0 : null,
      correctionPass: caseId === 'early-fact' ? metrics.strictClaimPass : null,
    },
    retrieval: {
      expected: test.expected,
      rank: test.expected.length ? 1 : null,
      forbiddenResults: [],
    },
    requestElapsedMs: 1,
    latencyMs: { model: 1 },
  };
}

describe('live comparison statistics', () => {
  it('retains conditional rates and counts failed positive requests as zero end-to-end hits', () => {
    const good = liveResult(0, 'truth'),
      failed = { id: `${evaluationStories[1]!.id}/truth`, strategy: 'hybrid', error: 'HTTP 502' },
      rows = [good, failed],
      before = JSON.stringify(rows),
      metric = summarizeLiveResults(rows).hybrid;
    expect(metric).toMatchObject({
      attemptedQuestions: 2,
      failedRequests: 1,
      strictGoldClaimPassRate: 0.5,
      exactFactMatchRate: 1,
      endToEndExactFactMatchRate: 0.5,
      recallAt5: 1,
      endToEndRecallAt5: 0.5,
      mrrAt5: 1,
      endToEndMrrAt5: 0.5,
      denominators: {
        returnedGoldClaims: 1,
        attemptedGoldClaims: 2,
        returnedPositiveQuestions: 1,
        attemptedPositiveQuestions: 2,
      },
    });
    expect(JSON.stringify(rows)).toBe(before);
    expect(metric.metricScope.exactFactMatchRate).toContain('条件统计');
  });

  it('separates forbidden historical values from character and span disclosure', () => {
    const temporal = liveResult(0, 'temporal-after', {
        answer: `从${evaluationStories[0]!.oldPlace}迁到${evaluationStories[0]!.newPlace}`,
        facts: [evaluationStories[0]!.newPlace],
        unknown: false,
        citations: [],
      }),
      disclosure = liveResult(0, 'secret-other', {
        answer: evaluationStories[0]!.secret,
        facts: [],
        unknown: true,
        citations: [],
      }),
      safe = liveResult(1, 'span-grant'),
      failed = {
        id: `${evaluationStories[2]!.id}/belief-other`,
        strategy: 'hybrid',
        error: 'HTTP 502',
      },
      metric = summarizeLiveResults([temporal, disclosure, safe, failed]).hybrid;
    expect(metric).toMatchObject({
      leakageRate: 2 / 3,
      disclosureRate: 0.5,
      disclosureMeasuredQuestions: 2,
      disclosureUnavailableQuestions: 1,
      endToEndDisclosureSafeResponseRate: 1 / 3,
    });
    expect(metric.metricScope.leakageRate).toContain('旧值');
    expect(metric.metricScope.disclosureRate).toContain('span-isolation');
  });

  it('fails an unknown=false assertion on an unknown question even without forbidden text', () => {
    const answer = { answer: '没有资料', facts: [], unknown: false, citations: [] },
      row = liveResult(0, 'secret-other', answer);
    expect(row.metrics).toMatchObject({
      leakedClaims: [],
      unknownPass: false,
      strictClaimPass: false,
    });
    expect(summarizeLiveResults([row]).hybrid).toMatchObject({
      strictGoldClaimPassRate: 0,
      disclosureRate: 0,
      endToEndDisclosureSafeResponseRate: 0,
    });
  });

  it('reports citation authorization separately and leaves fact entailment unmeasured', () => {
    const row = liveResult(0, 'truth');
    row.answer.citations = ['authorized-but-unrelated-source'];
    const metric = summarizeLiveResults([row]).hybrid;
    expect(metric.citationAuthorizationValidResponseRate).toBe(1);
    expect(metric.citationEvidenceSupport).toBeNull();
    expect(metric.metricScope.citationAuthorization).toContain('不验证');
  });

  it('cannot silently drop an unidentifiable failure from end-to-end denominators', () => {
    const metric = summarizeLiveResults([{ strategy: 'hybrid', error: 'HTTP 502' }]).hybrid;
    expect(metric).toMatchObject({
      strictGoldClaimPassRate: 0,
      endToEndExactFactMatchRate: null,
      endToEndRecallAt5: null,
    });
  });
});
