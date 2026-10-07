import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiBase, loadAuthHeaders, evaluationResponseError } from './live-evaluate';
import { settingsSchema } from '../src/server/settings';
import { aggregateExtractionQuality } from '../src/server/extraction-evaluation';
import { extractionQualityCases, vectorQualityFacts } from '../tests/fixtures/extraction-quality';
const rate = (n: number, d: number) => (d ? n / d : null);
export function aggregateVectorQuality(rows: any[]) {
  const positives = rows.filter((row) => vectorQualityFacts.some((f) => f.id === row.id)),
    negative = rows.filter((row) => ['secret-other', 'erased', 'cross-branch'].includes(row.id));
  return {
    positiveQuestions: positives.length,
    recallAt10: rate(positives.filter((row) => row.hitAt10 === true).length, positives.length),
    hybridRecallAt10: rate(
      positives.filter((row) => row.hybridHitAt10 === true).length,
      positives.length,
    ),
    negativeCases: negative.length,
    negativeMeasured: negative.filter((row) => row.negativePass !== null).length,
    negativePassed: negative.filter((row) => row.negativePass === true).length,
    forbiddenResults: rows.reduce((n, row) => n + row.forbiddenResults.length, 0),
    staleDeletedVectorObserved:
      rows.find((row) => row.id === 'erased')?.staleDeletedVectorObserved ?? null,
    vectorRecall90Gate:
      positives.length === 20
        ? positives.filter((row) => row.hitAt10 === true).length / 20 >= 0.9
        : null,
    actualVectorize: true,
    embeddingModel: '@cf/baai/bge-m3',
    dimension: 1024,
    corpusScope: '20固定原子事实+8干扰情节+2权限/删除案例；这不是大型外部benchmark',
  };
}
export async function main(args = process.argv.slice(2)) {
  const option = (key: string) => {
    const direct = args.find((value) => value.startsWith(`--${key}=`));
    if (direct) return direct.slice(key.length + 3);
    const at = args.indexOf(`--${key}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const numeric = (key: string, fallback: number, max: number) => {
    const value = Number(option(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`${key} 必须为1–${max}`);
    return value;
  };
  const cases = numeric('cases', 20, 20),
    maxModelCalls = numeric('max-model-calls', 60, 60),
    maxEmbeddingCalls = numeric('max-embedding-calls', 80, 80),
    run = args.includes('--run'),
    vectors = !args.includes('--extraction-only'),
    extract = !args.includes('--vector-only');
  const plan = {
    synthetic: true,
    extractionCases: extract ? cases : 0,
    positiveVectorQuestions: vectors ? 20 : 0,
    negativeVectorQuestions: vectors ? 3 : 0,
    worstModelCalls: extract ? cases * 3 : 0,
    maxModelCalls,
    maxEmbeddingCalls,
    realModelRun: run,
    costUSD: null,
    note: '默认零网络计划。--run 才调用真实 analyze 和 bge-m3/Vectorize；gold 固定、未判定不计作正确，episode 不计原子事实。',
  };
  if (!run) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  if (extract && maxModelCalls < cases * 3)
    throw new Error('模型调用预算低于明示的最坏尝试数；请明确设置足够预算');
  const headers = await loadAuthHeaders(process.env.API_AUTH_HEADERS_FILE),
    base = apiBase(process.env.LRP_BASE_URL || 'http://127.0.0.1:8787'),
    runId = option('run-id') || randomUUID(),
    output = resolve(option('output') || 'docs/model-quality-report.json'),
    journal = `${output}.jsonl`;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('run-id必须是UUID');
  const invoke = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}/evaluate/quality${path}`, {
      method: body == null ? 'GET' : 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw await evaluationResponseError(path, response);
    return (await response.json()) as any;
  };
  const report: any = {
    format: 'lightrp-real-model-quality',
    version: 1,
    startedAt: new Date().toISOString(),
    runId,
    status: 'running',
    plan,
    manifest: null,
    extractionResults: [],
    vectorReadiness: [],
    vectorResults: [],
    modelCalls: 0,
    embeddingCalls: 0,
    usage: [],
    measured: null,
    actualCostUSD: null,
    methodology: {
      modelCalls:
        'analyze发起complete的尝试次数，包括提供方拒绝或传输失败；不代表成功推理或可计费调用，另保留正文响应数与usage条目。',
      extraction:
        '固定人工规则匹配实际 analyze 输出。保留每次原始模型回应、结构化结果和未判定预测；完整语义precision需人工审查，提供透明上下界。',
      vector:
        '实际 bge-m3 1024维 + immutable Vectorize index；仅返回top10 ID，manifest完整scope映射及D1合法来源/角色授权回查。',
      privacy: '仅合成角色/原文；认证头和模型密钥不写入报告。',
    },
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(journal, '', { mode: 0o600 });
  await chmod(journal, 0o600);
  const record = async (entry: unknown) => appendFile(journal, JSON.stringify(entry) + '\n');
  const embedReservation = (limit: number) => {
    if (report.embeddingCalls + limit > maxEmbeddingCalls) throw new Error('达到明示embedding预算');
  };
  try {
    const manifest = await invoke('/manifest');
    if (
      JSON.stringify(manifest.extractionCases) !== JSON.stringify(extractionQualityCases) ||
      JSON.stringify(manifest.vectorFacts) !== JSON.stringify(vectorQualityFacts)
    )
      throw new Error('部署中的固定gold与本地gold不一致，禁止按不同答案评测');
    report.manifest = manifest;
    await record({ type: 'manifest', ...manifest });
    const settingsResponse = await fetch(`${base}/settings`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!settingsResponse.ok) throw await evaluationResponseError('/settings', settingsResponse);
    const settings = settingsSchema.parse(await settingsResponse.json());
    if (settings.mode === 'local-demo') throw new Error('当前服务配置为演示模式，不能实测');
    report.model = {
      mode: settings.mode,
      provider: settings.provider,
      model: settings.model,
      auxiliaryModel: settings.auxiliaryModel || null,
    };
    if (extract)
      for (const fixture of extractionQualityCases.slice(0, cases)) {
        const remaining = maxModelCalls - report.modelCalls;
        if (remaining < 3) throw new Error('剩余模型预算不足以覆盖声明的修复尝试');
        const result = await invoke('/extraction', {
          runId,
          caseId: fixture.id,
          settings,
          maxModelCalls: 3,
        });
        report.extractionResults.push(result);
        report.modelCalls += result.modelCalls;
        report.usage.push(...result.usage);
        await record({ type: 'extraction', ...result });
        process.stdout.write(
          `extraction ${fixture.id}: ${result.error ? 'validation-failed' : `TP ${result.score.counts.tp}, FP ${result.score.counts.fp}, unjudged ${result.score.counts.unjudged}`} (${report.modelCalls}/${maxModelCalls} model calls)\n`,
        );
        if (
          result.error &&
          !result.rawModelAttempts.some(
            (attempt: { phase: string }) => attempt.phase === 'response',
          )
        )
          throw new Error(
            '抽取未返回可验证正文，停止后续案例；已保存真实尝试、usage与安全错误代码',
          );
      }
    if (vectors) {
      const state = await invoke('/vector/setup', { runId });
      if (state.invalidated)
        throw new Error(
          '该run已删除对照来源，不能重写旧向量制造新的删除前证明；请使用新run或保留原始部分结果',
        );
      report.reusedVectorFixture = state.seeded > 0;
      for (let from = state.seeded; from < 20; from += 4)
        await invoke('/vector/seed', { runId, from, to: Math.min(from + 3, 19) });
      if (!state.erasedMemoryId || !state.secretMemoryId) await invoke('/vector/extras', { runId });
      embedReservation(10);
      const indexed = await invoke('/vector/index', { runId, maxEmbeddingCalls: 10 });
      report.embeddingCalls += indexed.embeddingCalls;
      report.vectorIndex = indexed;
      await record({ type: 'index', ...indexed });
      let ready = false;
      for (let attempt = 1; attempt <= 6; attempt++) {
        const probes = [];
        for (const id of ['ready-permit', 'ready-tunnel', 'erased-before']) {
          embedReservation(1);
          const result = await invoke('/vector/query', { runId, id });
          report.embeddingCalls += result.embeddingCalls;
          probes.push(result);
        }
        report.vectorReadiness.push({ attempt, probes });
        await record({ type: 'readiness', attempt, probes });
        if (probes.every((result) => result.hitAt10)) {
          ready = true;
          break;
        }
        process.stdout.write(
          `Vectorize indexing pending (${attempt}/6); exact-source probes not ready\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (!ready) throw new Error('Vectorize 尚未确认首尾语料与待删除旧向量可读，不能伪报召回指标');
      await invoke('/vector/invalidate', { runId });
      for (const id of [
        ...vectorQualityFacts.map((f) => f.id),
        'secret-owner',
        'secret-other',
        'erased',
        'cross-branch',
      ]) {
        embedReservation(1);
        const result = await invoke('/vector/query', { runId, id });
        report.embeddingCalls += result.embeddingCalls;
        report.vectorResults.push(result);
        await record({ type: 'vector-query', ...result });
        process.stdout.write(
          `vector ${id}: ${result.expectedMemoryId ? `rank ${result.rank ?? 'miss'}` : result.negativePass == null ? 'unmeasured negative' : result.negativePass ? 'blocked' : 'LEAK'}\n`,
        );
      }
    }
    report.status = report.extractionResults.some((result: any) => result.error)
      ? 'completed-with-errors'
      : 'completed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : '评测失败';
    await record({ type: 'failure', error: report.error });
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.returnedModelResponses = report.extractionResults.reduce(
      (count: number, result: any) =>
        count +
        result.rawModelAttempts.filter((attempt: { phase: string }) => attempt.phase === 'response')
          .length,
      0,
    );
    report.reportedUsageEntries = report.usage.length;
    const measuredExtractions = report.extractionResults.filter((result: any) =>
        result.rawModelAttempts.some((attempt: { phase: string }) => attempt.phase === 'response'),
      ),
      transportFailures = report.extractionResults.filter(
        (result: any) =>
          result.error &&
          result.usage.length === 0 &&
          !result.rawModelAttempts.some(
            (attempt: { phase: string }) => attempt.phase === 'response',
          ),
      );
    if (
      extract &&
      report.extractionResults.length > 0 &&
      transportFailures.length === report.extractionResults.length
    )
      report.status = 'transport-failed';
    report.transportAudit = {
      modelInvocationAttempts: report.modelCalls,
      returnedModelResponses: report.returnedModelResponses,
      reportedUsageEntries: report.reportedUsageEntries,
      attemptedCases: report.extractionResults.length,
      measuredCases: measuredExtractions.length,
      noResponseCases: transportFailures.map((result: any) => result.id),
      unusableResponseCases: report.extractionResults
        .filter(
          (result: any) =>
            result.usage.length > 0 &&
            !result.rawModelAttempts.some(
              (attempt: { phase: string }) => attempt.phase === 'response',
            ),
        )
        .map((result: any) => result.id),
      note: '没有正文也没有usage的失败只计传输故障；有usage但缺少可验证正文的失败另列，均不计算语义precision/recall。逐项原始结果仍完整保留。',
    };
    const extractionMetrics =
      extract && measuredExtractions.length > 0
        ? aggregateExtractionQuality(measuredExtractions)
        : null;
    if (extractionMetrics && measuredExtractions.length !== cases)
      extractionMetrics.factPrecision95Gate = null;
    report.measured = {
      extraction: extractionMetrics,
      vector: vectors ? aggregateVectorQuality(report.vectorResults) : null,
    };
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    await chmod(output, 0o600);
    process.stdout.write(
      JSON.stringify(
        {
          status: report.status,
          modelCalls: report.modelCalls,
          returnedModelResponses: report.returnedModelResponses,
          reportedUsageEntries: report.reportedUsageEntries,
          embeddingCalls: report.embeddingCalls,
          measured: report.measured,
          output,
          ...(report.error ? { error: report.error } : {}),
        },
        null,
        2,
      ) + '\n',
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : '实测失败') + '\n');
    process.exitCode = 1;
  });
