import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { evaluationStories, goldQuestions } from '../tests/fixtures/evaluation-stories';
import { settingsSchema, type ModelSettings } from '../src/server/settings';
import type { EvaluationSummary, EvaluationStrategy } from '../src/server/evaluation';

const safeErrorCodes = new Set([
  'REQUEST_FAILED',
  'BODY_LIMIT',
  'NOT_FOUND',
  'VALIDATION',
  'INTERNAL',
  'STALE_WRITE',
  'UNAUTHORIZED',
  'AUTH_REQUIRED',
  'AUTH_UNAVAILABLE',
  'FORBIDDEN',
  'OUTPUT_TRUNCATED',
  'MODEL_HTTP',
  'MODEL_EMPTY',
  'MODEL_TOO_LARGE',
  'MODEL_STREAM_ERROR',
  'MODEL_STREAM_INCOMPLETE',
  'MODEL_URL',
  'MODEL_KEY_MISSING',
  'EVALUATION_BUDGET',
  'EVALUATION_REAL_MODEL_REQUIRED',
  'EVALUATION_SETUP',
  'EVALUATION_INCOMPLETE',
  'EVALUATION_STALE',
  'EVALUATION_SUMMARY_OUTPUT_BUDGET',
  'EVALUATION_SUMMARY_JSON',
  'EVALUATION_SUMMARY_SCHEMA',
  'EVALUATION_SUMMARY_CITATION',
  'EVALUATION_SUMMARY_REQUIRED',
]);
export class EvaluationRequestError extends Error {
  constructor(
    public path: string,
    public status: number,
    public code: string | null,
  ) {
    super(
      `评测接口${path}返回HTTP ${status}${code ? ` (${code})` : ''}；认证与模型凭据不写入错误输出`,
    );
  }
}
/** Keep only recognized diagnostic codes. Never copy provider messages, HTML or headers. */
export async function evaluationResponseError(
  path: string,
  response: Response,
): Promise<EvaluationRequestError> {
  let code: string | null = null;
  if (response.headers.get('content-type')?.includes('application/json') && response.body) {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let text = '',
      bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8192) {
          text = '';
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      if (text) {
        const input = JSON.parse(text + decoder.decode()) as { error?: { code?: unknown } };
        if (typeof input.error?.code === 'string' && safeErrorCodes.has(input.error.code))
          code = input.error.code;
      }
    } catch {
      /* An unreadable body still has a useful HTTP status. */
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else await response.body?.cancel();
  return new EvaluationRequestError(path, response.status, code);
}
const requestFailure = (error: unknown) =>
  error instanceof EvaluationRequestError
    ? { path: error.path, status: error.status, code: error.code }
    : null;

/** No secret is accepted on the command line, copied into a report, or printed. */
export async function loadAuthHeaders(file?: string): Promise<Record<string, string>> {
  if (!file) return {};
  const path = resolve(file),
    metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384)
    throw new Error('认证头文件必须是普通文件且小于16KB');
  if ((metadata.mode & 0o777) !== 0o600 || (process.getuid && metadata.uid !== process.getuid()))
    throw new Error('认证头文件必须属于当前用户且权限为0600');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (
      actual.ino !== metadata.ino ||
      actual.dev !== metadata.dev ||
      (actual.mode & 0o777) !== 0o600
    )
      throw new Error('认证头文件在读取前发生变化');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch {
      throw new Error('认证头文件必须是JSON对象');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
      throw new Error('认证头文件必须是JSON对象');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        typeof value !== 'string' ||
        /[\r\n]/.test(value) ||
        value.length > 8192
      )
        throw new Error('认证头文件包含无效字段');
      if (['host', 'content-type', 'content-length', 'origin'].includes(name.toLowerCase()))
        throw new Error('认证头文件不能覆盖请求地址和内容格式');
      headers[name] = value;
    }
    return headers;
  } finally {
    await handle.close();
  }
}
export function apiBase(input: string) {
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('远程评测地址必须使用HTTPS');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('评测地址不能包含凭据、查询参数或片段');
  return (
    url
      .toString()
      .replace(/\/$/, '')
      .replace(/\/api\/v3$/, '') + '/api/v3'
  );
}
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
};
const rate = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;
export function summarizeLiveResults(results: any[]) {
  return Object.fromEntries(
    (['recent', 'summary', 'hybrid'] as EvaluationStrategy[]).map((strategy) => {
      const attempted = results.filter((row) => row.strategy === strategy),
        rows = attempted.filter((row) => !row.error),
        positives = rows.filter((row) => row.retrieval.expected.length && strategy === 'hybrid');
      const leakageCases = rows.filter((row) => row.metrics.leakage != null),
        corrections = rows.filter((row) => row.metrics.correctionPass != null);
      const testedClaims = rows.flatMap((row) => [
          ...row.metrics.matchedClaims,
          ...row.metrics.missingClaims,
        ]),
        matched = rows.flatMap((row) => row.metrics.matchedClaims);
      return [
        strategy,
        {
          questions: rows.length,
          attemptedQuestions: attempted.length,
          failedRequests: results.filter((row) => row.strategy === strategy && row.error).length,
          validJsonResponses: rows.filter((row) => row.schemaValid).length,
          strictGoldClaimPassRate: rate(
            rows.filter(
              (row) =>
                row.schemaValid &&
                row.metrics.strictClaimPass &&
                row.metrics.citationViolations?.length === 0,
            ).length,
            attempted.length,
          ),
          exactFactMatchRate: rate(matched.length, testedClaims.length),
          leakageRate: rate(
            leakageCases.filter((row) => row.metrics.leakage).length,
            leakageCases.length,
          ),
          correctionPassRate: rate(
            corrections.filter((row) => row.metrics.correctionPass).length,
            corrections.length,
          ),
          recallAt5:
            strategy === 'hybrid'
              ? rate(
                  positives.filter((row) => row.retrieval.rank != null && row.retrieval.rank <= 5)
                    .length,
                  positives.length,
                )
              : null,
          mrrAt5:
            strategy === 'hybrid'
              ? rate(
                  positives.reduce(
                    (sum, row) =>
                      sum +
                      (row.retrieval.rank != null && row.retrieval.rank <= 5
                        ? 1 / row.retrieval.rank
                        : 0),
                    0,
                  ),
                  positives.length,
                )
              : null,
          forbiddenMemoryResults:
            strategy === 'hybrid'
              ? rows.reduce((sum, row) => sum + row.retrieval.forbiddenResults.length, 0)
              : null,
          citationViolations: rows.length
            ? rows.reduce((sum, row) => sum + (row.metrics.citationViolations?.length ?? 0), 0)
            : null,
          latencyMs: {
            p50: percentile(
              rows.map((row) => row.requestElapsedMs),
              0.5,
            ),
            p95: percentile(
              rows.map((row) => row.requestElapsedMs),
              0.95,
            ),
            max: rows.length ? Math.max(...rows.map((row) => row.requestElapsedMs)) : null,
          },
          modelLatencyMs: {
            p50: percentile(
              rows.map((row) => row.latencyMs.model),
              0.5,
            ),
            p95: percentile(
              rows.map((row) => row.latencyMs.model),
              0.95,
            ),
          },
          actualVectorizeRecall: null,
          semanticAnswerAccuracy: null,
          extractionPrecision: null,
          extractionRecall: null,
          actualCostUSD: null,
        },
      ];
    }),
  );
}
function selectQuestions(limit: number) {
  if (limit >= goldQuestions.length) return [...goldQuestions];
  const priority = [
    'early-fact',
    'belief-owner',
    'secret-other',
    'span-grant',
    'temporal-before',
    'fork-parent-future',
    'skill-evidence',
    'erased',
    'relationship',
    'truth',
    'belief-other',
    'secret-owner',
    'temporal-after',
    'fork-alternative',
    'forgotten',
    'cross-story-vector',
  ];
  const ordered = priority.flatMap((caseId) =>
    evaluationStories.map((story) =>
      goldQuestions.find(
        (question) => question.storyId === story.id && question.caseId === caseId,
      )!,
    ),
  );
  // Small runs cover distinct invariants before repeating the same case across stories.
  const balanced = evaluationStories.flatMap((_, storyIndex) =>
    priority.map((caseId, caseIndex) =>
      ordered.find(
        (question) =>
          question.storyId ===
            evaluationStories[(storyIndex + caseIndex) % evaluationStories.length]!.id &&
          question.caseId === caseId,
      )!,
    ),
  );
  return [...new Map(balanced.map((question) => [question.id, question])).values()].slice(0, limit);
}
function summaryGroup(question: (typeof goldQuestions)[number]) {
  const actor = ['belief-owner', 'secret-owner', 'span-grant', 'skill-evidence'].includes(
    question.caseId,
  )
    ? 'actor-a'
    : ['belief-other', 'secret-other'].includes(question.caseId)
      ? 'actor-b'
      : 'director';
  const branch = question.caseId.startsWith('fork-') ? 'fork' : 'main',
    time =
      question.caseId === 'temporal-before'
        ? 20
        : question.caseId === 'temporal-after'
          ? 50
          : 'current';
  return `${question.storyId}:${branch}:${actor}:${time}`;
}
async function pool<T>(items: T[], concurrency: number, job: (item: T) => Promise<void>) {
  let cursor = 0,
    failed: unknown;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          await job(items[index]!);
        } catch (error) {
          failed = error;
        }
      }
    }),
  );
  if (failed) throw failed;
}
export async function main(args = process.argv.slice(2)) {
  const option = (name: string) => {
    const direct = args.find((arg) => arg.startsWith(`--${name}=`));
    if (direct) return direct.slice(name.length + 3);
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(option(name) ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} 必须为 ${min}–${max} 的整数`);
    return value;
  };
  const limit = args.includes('--full')
      ? goldQuestions.length
      : number('questions', 8, 1, goldQuestions.length),
    concurrency = number('concurrency', 2, 1, 2);
  const questions = selectQuestions(limit),
    maxModelCalls = number('max-model-calls', 33, 1, 513),
    groups = new Set(questions.map(summaryGroup));
  const plannedCalls = 1 + questions.length * 3 + groups.size,
    worstCalls = 1 + questions.length * 4;
  const base = apiBase(process.env.LRP_BASE_URL || 'http://127.0.0.1:8787'),
    run = args.includes('--run');
  const plan = {
    stories: evaluationStories.length,
    authoredGoldQuestions: goldQuestions.length,
    selectedQuestions: questions.length,
    replayTurns: 520,
    strategies: ['recent', 'summary', 'hybrid'],
    concurrency,
    expectedModelCallsWithSummaryReuse: plannedCalls,
    worstModelCallsWithoutReuse: worstCalls,
    maxModelCalls,
    costUSD: null,
    realModelRun: run,
    note: '默认只显示计划。--run才调用真实模型；--full --max-model-calls=513覆盖128×3。人工gold只测召回与回答，抽取质量/真实Vectorize/语义判分不测。',
  };
  if (!run) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  if (maxModelCalls < plannedCalls)
    throw new Error(`模型预算不足：当前计划需要${plannedCalls}次；设置 --max-model-calls 后重试`);
  const headers = await loadAuthHeaders(process.env.API_AUTH_HEADERS_FILE);
  const invoke = async (path: string, body?: unknown) => {
    const started = performance.now(),
      response = await fetch(`${base}${path}`, {
        method: body == null ? 'GET' : 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(300000),
      });
    if (!response.ok) throw await evaluationResponseError(path, response);
    return { data: (await response.json()) as any, requestElapsedMs: performance.now() - started };
  };
  let settings: ModelSettings;
  const settingsFile = option('settings-file') || process.env.LRP_MODEL_SETTINGS_FILE;
  if (settingsFile) {
    const input = JSON.parse(await readFile(resolve(settingsFile), 'utf8'));
    if (Object.keys(input).some((key) => /key|secret|token/i.test(key)))
      throw new Error('模型配置文件不能包含密钥；密钥只能在服务端secret中');
    settings = settingsSchema.parse(input);
  } else settings = settingsSchema.parse((await invoke('/settings')).data);
  if (settings.mode === 'local-demo')
    throw new Error('配置为本地演示，不执行真实模型评测。使用服务端真实配置或 --settings-file。');
  const reuse = option('reuse-fixtures');
  if (
    reuse &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reuse)
  )
    throw new Error('reuse-fixtures需要有效run UUID');
  const runId = reuse ?? randomUUID(),
    timestamp = new Date().toISOString(),
    output = resolve(
      option('output') || `reports/live-evaluation-${timestamp.replace(/[:.]/g, '-')}.json`,
    ),
    journal = `${output}.jsonl`;
  const report: any = {
    format: 'lightrp-live-memory-evaluation',
    version: 1,
    timestamp,
    runId,
    status: 'running',
    plan,
    baseUrl: base,
    model: {
      mode: settings.mode,
      provider: settings.provider,
      model: settings.model,
      auxiliaryModel: settings.auxiliaryModel || null,
    },
    dataset: null,
    probe: null,
    summaries: [],
    results: [],
    modelCallAttempts: 0,
    measured: null,
    extractionPrecision: null,
    extractionRecall: null,
    actualVectorizeRecall: null,
    semanticAnswerAccuracy: null,
    actualCostUSD: null,
    methodology: {
      baseline: {
        recent: '最近16条经过分支/时点/知情/遗忘/删源过滤的原文',
        summary: '真实模型对同一有效原文集压缩，仅在相同来源fence与视角内复用',
        hybrid: '近期原文+实际Store词法/关系图/时间召回；人工旧向量ID只测试权限过滤',
      },
      claims: '中文NFKC及标点空白归一后的严格gold片段匹配；不代表模型语义judge',
      synthetic: true,
      goldExtraction: 'authored',
      unmeasured:
        '抽取precision/recall、实际Vectorize召回、语义回答准确率和真实成本均为null；usage仅记录服务商实际返回值',
    },
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(journal, '', { mode: 0o600 });
  await chmod(journal, 0o600);
  let writing = Promise.resolve();
  const record = (entry: unknown) => {
    writing = writing.then(() => appendFile(journal, JSON.stringify(entry) + '\n'));
    return writing;
  };
  const reserve = () => {
    if (report.modelCallAttempts >= maxModelCalls)
      throw new Error('达到明确模型调用预算，已停止后续模型请求');
    report.modelCallAttempts++;
  };
  const charged = async (path: string, body: unknown) => {
    reserve();
    return invoke(path, body);
  };
  try {
    const probe = await charged('/settings/probe', settings);
    if (!probe.data.ok || probe.data.mode === 'local-demo')
      throw new Error('真实模型连通性探测未通过');
    report.probe = {
      ok: probe.data.ok,
      mode: probe.data.mode,
      rawAnswer: probe.data.message,
      elapsedMs: probe.requestElapsedMs,
      modelCalls: 1,
      usage: probe.data.usage ?? null,
      costUSD: null,
    };
    await record({ type: 'probe', ...report.probe });
    if (!reuse) await invoke('/evaluate/fixtures', { runId });
    // Corrections/deletions advance the owner-wide epoch. Serialize fixture writes;
    // only the read-only summary/answer model comparisons run concurrently.
    for (const story of reuse ? [] : evaluationStories) {
      for (let from = 1; from <= 64; from += 8)
        await invoke('/evaluate/replay', { runId, storyId: story.id, from, to: from + 7 });
      process.stdout.write(`replayed ${story.id} 65 committed turns\n`);
    }
    report.dataset = (await invoke('/evaluate/counts', { runId })).data;
    if (
      report.dataset.stories !== 8 ||
      report.dataset.replayedTurns < 500 ||
      report.dataset.authoredGoldQuestions !== 128
    )
      throw new Error('实际回放数不符合评测要求');
    await record({ type: 'dataset', ...report.dataset });
    const summaries = new Map<string, Promise<{ artifact: EvaluationSummary }>>();
    await pool(questions, concurrency, async (question) => {
      const common = { runId, storyId: question.storyId, caseId: question.caseId, settings };
      for (const strategy of ['recent', 'summary', 'hybrid'] as EvaluationStrategy[]) {
        try {
          let summary: EvaluationSummary | undefined;
          if (strategy === 'summary') {
            const group = summaryGroup(question);
            if (!summaries.has(group))
              summaries.set(
                group,
                (async () => {
                  const response = await charged('/evaluate/summary', common);
                  const result = {
                    group,
                    ...response.data,
                    requestElapsedMs: response.requestElapsedMs,
                  };
                  report.summaries.push(result);
                  await record({ type: 'summary', ...result });
                  return response.data;
                })(),
              );
            summary = (await summaries.get(group)!).artifact;
          }
          const response = await charged('/evaluate/answer', {
            ...common,
            strategy,
            ...(summary ? { summary } : {}),
          });
          const result = { ...response.data, requestElapsedMs: response.requestElapsedMs };
          report.results.push(result);
          await record({ type: 'answer', ...result });
          process.stdout.write(
            `${report.results.length}/${questions.length * 3} ${question.id} ${strategy} ${result.metrics.strictClaimPass ? 'gold-match' : 'gold-miss'}\n`,
          );
        } catch (error) {
          const result = {
            id: question.id,
            strategy,
            error: error instanceof Error ? error.message : '评测请求失败',
            requestFailure: requestFailure(error),
            usage: null,
            costUSD: null,
          };
          report.results.push(result);
          await record({ type: 'error', ...result });
          process.stdout.write(
            `${report.results.length}/${questions.length * 3} ${question.id} ${strategy} request-failed\n`,
          );
        }
      }
    });
    report.status = report.results.some((result: { error?: string }) => result.error)
      ? 'complete-with-errors'
      : 'complete';
    if (report.status !== 'complete') process.exitCode = 1;
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : '真实模型评测失败';
    report.requestFailure = requestFailure(error);
    process.exitCode = 1;
  } finally {
    await writing;
    report.measured = summarizeLiveResults(report.results);
    report.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    await chmod(output, 0o600);
    process.stdout.write(
      JSON.stringify(
        {
          status: report.status,
          dataset: report.dataset,
          modelCallAttempts: report.modelCallAttempts,
          actualCostUSD: null,
          measured: report.measured,
          output,
          journal,
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
    process.stderr.write((error instanceof Error ? error.message : '真实模型评测失败') + '\n');
    process.exitCode = 1;
  });
