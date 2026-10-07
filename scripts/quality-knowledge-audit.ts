import { extractionQualityCases } from '../tests/fixtures/extraction-quality';

/** Additional safety rules derived from explicit negation in the unchanged synthetic original text.
 * They do not replace atomic-fact gold and apply to every memory kind, including episodes. */
export const explicitKnowledgeNegations = [
  {
    caseId: 'q01-truth',
    forbidden: ['actor-a', 'actor-b', 'actor-c'],
    groups: [['钥匙'], ['仓库']],
    quote: '没有角色看到这一幕。',
  },
  {
    caseId: 'q02-lie',
    forbidden: ['actor-c'],
    groups: [['钥匙'], ['仓库', '撒谎', '相信']],
    quote: '丙没有听到。',
  },
  {
    caseId: 'q03-inner',
    forbidden: ['actor-b', 'actor-c'],
    groups: [['子夜', '东桥', '内心', '线人']],
    quote: '乙和丙都不知道。',
  },
  {
    caseId: 'q04-told',
    forbidden: ['actor-c'],
    groups: [['钥匙'], ['仓库', '告诉', '告知', '听清', '记住']],
    quote: '丙在远处没有听到。',
  },
  {
    caseId: 'q05-guess',
    forbidden: ['actor-b'],
    groups: [['下雨', '天气', '猜测']],
    quote: '乙没有听到甲的猜测。',
  },
  {
    caseId: 'q17-selective',
    forbidden: ['actor-b', 'actor-c'],
    groups: [['子夜', '东桥', '内心', '秘密计划']],
    quote: '乙不知道这个内心计划，丙也不知道。',
  },
] as const;

type Row = {
  id?: string;
  extraction?: unknown;
  error?: unknown;
  rawModelAttempts?: { attempt?: number; phase: string; rawOutput?: string }[];
};
const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
function identity(value: unknown) {
  const normalized = normalize(String(value));
  return (
    (
      {
        'actor-a': 'actor-a',
        'actor-b': 'actor-b',
        'actor-c': 'actor-c',
        甲: 'actor-a',
        乙: 'actor-b',
        丙: 'actor-c',
      } as Record<string, string>
    )[String(value)] ||
    ({ actora: 'actor-a', actorb: 'actor-b', actorc: 'actor-c' } as Record<string, string>)[
      normalized
    ] ||
    String(value)
  );
}
function content(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(content).join(' ');
  if (typeof value === 'object')
    return Object.entries(value)
      .filter(
        ([key]) =>
          !['evidence', 'knowledge', 'acquisitionProofs', 'knownBy', 'observerId', 'id'].includes(
            key,
          ),
      )
      .map(([, item]) => content(item))
      .join(' ');
  return String(value);
}
function candidates(value: unknown) {
  if (!value || typeof value !== 'object') return [];
  const body = value as Record<string, unknown>;
  return ['facts', 'experiences', 'capabilities'].flatMap((category) =>
    Array.isArray(body[category])
      ? (body[category] as unknown[]).map((raw, index) => ({ category, index, raw }))
      : [],
  );
}
function parse(rawOutput: string) {
  return JSON.parse(
    rawOutput
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, ''),
  ) as unknown;
}
export function auditExtractionKnowledge(rows: Row[]) {
  const evaluatedCaseIds = rows
      .filter((row) => explicitKnowledgeNegations.some((rule) => rule.caseId === row.id))
      .map((row) => row.id),
    acceptedViolations: unknown[] = [],
    rawAttemptViolations: unknown[] = [],
    unparseableAttempts: {
      caseId: string | undefined;
      attempt: number | undefined;
      phase: string;
    }[] = [];
  let acceptedCandidates = 0,
    rawAttemptCandidates = 0;
  for (const row of rows) {
    const rules = explicitKnowledgeNegations.filter((rule) => rule.caseId === row.id);
    if (!rules.length) continue;
    const scan = (value: unknown, phase: string, attempt?: number) => {
      for (const candidate of candidates(value)) {
        if (phase === 'accepted') acceptedCandidates++;
        else rawAttemptCandidates++;
        const raw = candidate.raw as Record<string, unknown> | null;
        if (!raw) continue;
        const claimedActors = [
          ...(Array.isArray(raw.knownBy) ? raw.knownBy : []),
          ...(Array.isArray(raw.knowledge)
            ? raw.knowledge
                .map((proof: any) => proof?.actorId)
                .filter((actor: unknown) => typeof actor === 'string')
            : []),
        ];
        if (!claimedActors.length) continue;
        const text = normalize(content(raw));
        for (const rule of rules) {
          if (!rule.groups.every((group) => group.some((word) => text.includes(normalize(word)))))
            continue;
          const forbiddenActors = claimedActors
            .map(identity)
            .filter((actor) => (rule.forbidden as readonly string[]).includes(actor));
          if (!forbiddenActors.length) continue;
          const violation = {
            caseId: row.id,
            phase,
            attempt: attempt ?? null,
            category: candidate.category,
            kind: raw.kind ?? null,
            index: candidate.index,
            forbiddenActors: [...new Set(forbiddenActors)],
            explicitNegation: rule.quote,
            sourceText: extractionQualityCases.find((fixture) => fixture.id === row.id)!.assistant,
            candidate: raw,
          };
          (phase === 'accepted' ? acceptedViolations : rawAttemptViolations).push(violation);
        }
      }
    };
    if (row.extraction && !row.error) scan(row.extraction, 'accepted');
    for (const attempt of row.rawModelAttempts ?? []) {
      if (!['response', 'truncated'].includes(attempt.phase) || !attempt.rawOutput) continue;
      try {
        scan(parse(attempt.rawOutput), attempt.phase, attempt.attempt);
      } catch {
        unparseableAttempts.push({
          caseId: row.id,
          attempt: attempt.attempt,
          phase: attempt.phase,
        });
      }
    }
  }
  return {
    ruleSource: '固定原文中明确的未听到/不知道；独立安全审计，不改原子事实 gold。',
    kinds:
      '所有 facts kinds（包括 episode）、experience、capability 的 knownBy 或 knowledge actorId 主张；不因原子 precision 排除 episode。',
    evaluatedCaseIds,
    acceptedCandidates,
    rawAttemptCandidates,
    acceptedViolationCount: acceptedViolations.length,
    rawAttemptViolationCount: rawAttemptViolations.length,
    acceptedViolations,
    rawAttemptViolations,
    unparseableAttempts,
    note: '仅评已有明确否定且内容命中固定范围的候选；零命中或未返回不证明授权正确。多次修复的候选重复列出，不代表独立经历；服务器拒绝的 raw candidate 不视为已提交泄漏。',
  };
}
