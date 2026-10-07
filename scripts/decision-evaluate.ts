import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { apiBase, loadAuthHeaders, evaluationResponseError } from './live-evaluate';
import { decisionQualityCases } from '../tests/fixtures/decision-quality';
import { decisionModels } from '../src/shared/api';

const args = process.argv.slice(2),
  run = args.includes('--run');
const value = (key: string) =>
  args.find((a) => a.startsWith('--' + key + '='))?.slice(key.length + 3);
const maxCalls = Number(value('max-model-calls') ?? 40);
const plan = {
  cases: 20,
  models: decisionModels,
  modelCalls: 40,
  realModelRun: run,
  actualBillUsd: null,
};
if (!run) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
else {
  if (!Number.isInteger(maxCalls) || maxCalls < 40 || maxCalls > 40)
    throw new Error('完整固定语料需要 --max-model-calls=40');
  const headers = await loadAuthHeaders(process.env.API_AUTH_HEADERS_FILE),
    base = apiBase(process.env.LRP_BASE_URL || 'http://127.0.0.1:8787');
  const output = resolve(value('output') || 'docs/clef-worker-evaluation-report.json');
  const invoke = async (path: string, body?: unknown) => {
    const response = await fetch(base + '/evaluate/decisions' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw await evaluationResponseError(path, response);
    return (await response.json()) as any;
  };
  const manifest = await invoke('/manifest');
  if (JSON.stringify(manifest.cases) !== JSON.stringify(decisionQualityCases))
    throw new Error('部署语料与本地固定 gold 不匹配');
  const report: any = {
    format: 'lightrp-real-decision-quality',
    version: 1,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: 'running',
    plan,
    manifest,
    modelCalls: 0,
    results: [],
    measured: null,
    actualBillUsd: null,
    methodology: {
      scope: '实际 Worker AI binding + Gateway，单场景单候选，无独立故事混批；gold不传入judge。',
      classification: 'p>=0.5 二分；实际接受p>=0.9，拒绝p<=0.1，其他保留灰区。阈值未经大样本校准。',
      privacy: '仅合成资料，认证信息不入报告。',
      limitations: '20例固定合成回归不是通用质量保证或生产长原文评测。',
    },
  };
  await mkdir(dirname(output), { recursive: true });
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await save();
  for (const model of decisionModels)
    for (const c of decisionQualityCases) {
      report.modelCalls++;
      try {
        const result = await invoke('/judge', { model, caseId: c.id });
        const p = result.answers.supported.probability;
        if (typeof p !== 'number' || p < 0 || p > 1) throw new Error('无效概率');
        report.results.push({
          id: c.id,
          expected: c.expected,
          model,
          result,
          classificationCorrect: p >= 0.5 === c.expected,
        });
      } catch (error) {
        report.results.push({
          id: c.id,
          expected: c.expected,
          model,
          error: error instanceof Error ? error.message : 'REQUEST_FAILED',
        });
      }
      await save();
    }
  report.measured = Object.fromEntries(
    decisionModels.map((model) => {
      const rows = report.results.filter((r: any) => r.model === model),
        valid = rows.filter((r: any) => !r.error),
        latencies = valid.map((r: any) => r.result.latencyMs).sort((a: number, b: number) => a - b);
      return [
        model,
        {
          attempted: rows.length,
          valid: valid.length,
          errors: rows.length - valid.length,
          correct: rows.filter((r: any) => r.classificationCorrect).length,
          classificationAccuracy:
            rows.filter((r: any) => r.classificationCorrect).length / rows.length,
          supported: valid.filter((r: any) => r.result.answers.supported.verdict === 'supported')
            .length,
          rejected: valid.filter((r: any) => r.result.answers.supported.verdict === 'rejected')
            .length,
          uncertain: valid.filter((r: any) => r.result.answers.supported.verdict === 'uncertain')
            .length,
          falseAccepts: valid.filter(
            (r: any) => r.result.answers.supported.verdict === 'supported' && !r.expected,
          ).length,
          falseRejects: valid.filter(
            (r: any) => r.result.answers.supported.verdict === 'rejected' && r.expected,
          ).length,
          inputTokens: valid.reduce(
            (n: number, r: any) => n + (r.result.usage?.input_tokens ?? 0),
            0,
          ),
          outputTokens: valid.reduce(
            (n: number, r: any) => n + (r.result.usage?.output_tokens ?? 0),
            0,
          ),
          latencyMs: {
            p50: latencies[Math.ceil(latencies.length * 0.5) - 1] ?? null,
            p95: latencies[Math.ceil(latencies.length * 0.95) - 1] ?? null,
          },
        },
      ];
    }),
  );
  report.finishedAt = new Date().toISOString();
  report.status = report.results.some((r: any) => r.error) ? 'partial' : 'complete';
  await save();
  process.stdout.write(
    JSON.stringify(
      { status: report.status, modelCalls: report.modelCalls, measured: report.measured },
      null,
      2,
    ) + '\n',
  );
  if (report.status !== 'complete') process.exitCode = 1;
}
