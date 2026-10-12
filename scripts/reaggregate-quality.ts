import { createHash } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateExtractionQuality,
  summarizeExtractionAttempts,
} from '../src/server/extraction-evaluation';
import { aggregateVectorQuality } from './quality-evaluate';
import { auditExtractionKnowledge } from './quality-knowledge-audit';

/** Offline derived statistics only. Raw cases, model attempts, usage and gold are never rewritten. */
export function reaggregateQualityReport(report: any) {
  if (report.format !== 'lightrp-real-model-quality' || !Array.isArray(report.extractionResults))
    throw new Error('仅允许已有合成质量评测报告');
  const originalRows = JSON.stringify(report.extractionResults),
    digest = createHash('sha256').update(originalRows).digest('hex'),
    rows = report.extractionResults,
    measurable = rows.filter((row: any) =>
      row.rawModelAttempts?.some((attempt: any) => attempt.phase === 'response'),
    );
  const derived = structuredClone(report);
  derived.returnedModelResponses = rows.reduce(
    (total: number, row: any) =>
      total + row.rawModelAttempts.filter((attempt: any) => attempt.phase === 'response').length,
    0,
  );
  derived.truncatedModelResponses = rows.reduce(
    (total: number, row: any) =>
      total + row.rawModelAttempts.filter((attempt: any) => attempt.phase === 'truncated').length,
    0,
  );
  derived.reportedUsageEntries = report.usage.length;
  if (
    rows.length &&
    rows.every(
      (row: any) =>
        row.error &&
        !row.usage.length &&
        !row.rawModelAttempts.some((attempt: any) =>
          ['response', 'truncated'].includes(attempt.phase),
        ),
    )
  )
    derived.status = 'transport-failed';
  else if (['completed', 'completed-with-errors'].includes(report.status))
    derived.status = rows.some((row: any) => row.error) ? 'completed-with-errors' : 'completed';
  derived.measured = {
    ...report.measured,
    extraction: measurable.length ? aggregateExtractionQuality(measurable) : null,
    extractionEndToEnd: report.plan.extractionCases ? summarizeExtractionAttempts(rows) : null,
    knowledgeSafety: report.plan.extractionCases ? auditExtractionKnowledge(rows) : null,
    vector: report.plan.positiveVectorQuestions
      ? aggregateVectorQuality(report.vectorResults)
      : null,
  };
  derived.derivedStatisticsAudit = {
    ...(report.derivedStatisticsAudit ?? {}),
    version: 2,
    updatedAt: new Date().toISOString(),
    rawResultsSha256: digest,
    originalStatus: report.derivedStatisticsAudit?.originalStatus ?? report.status,
    note: '仅重算派生汇总与传输分类；原始案例、人工 gold、原始模型输出、usage 完整保持。条件语义统计与全尝试端到端召回分开；episode 额外接受独立知情安全审计。',
  };
  if (JSON.stringify(derived.extractionResults) !== originalRows)
    throw new Error('拒绝修改原始评测案例');
  return derived;
}
export async function main(args = process.argv.slice(2)) {
  const write = args.includes('--write'),
    files = args.filter((arg) => arg !== '--write');
  if (!files.length)
    throw new Error('传入已有质量报告路径；默认 dry-run，--write 才更新派生汇总。零网络调用。');
  for (const file of files) {
    const path = resolve(file),
      report = reaggregateQualityReport(JSON.parse(await readFile(path, 'utf8')));
    if (write) {
      await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
      await chmod(path, 0o600);
    }
    process.stdout.write(
      JSON.stringify({
        path,
        written: write,
        status: report.status,
        rawResultsSha256: report.derivedStatisticsAudit.rawResultsSha256,
        factPrecision95Gate: report.measured.extraction?.factPrecision95Gate ?? null,
        factEndToEnd: report.measured.extractionEndToEnd?.facts ?? null,
        acceptedKnowledgeViolations:
          report.measured.knowledgeSafety?.acceptedViolationCount ?? null,
        rawKnowledgeViolations: report.measured.knowledgeSafety?.rawAttemptViolationCount ?? null,
        vectorRecall90Gate: report.measured.vector?.vectorRecall90Gate ?? null,
      }) + '\n',
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : '离线汇总失败') + '\n');
    process.exitCode = 1;
  });
