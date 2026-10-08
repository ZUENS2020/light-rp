import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { vectorQualityFacts } from '../tests/fixtures/extraction-quality';

const models = ['@cf/baai/bge-m3', '@cf/qwen/qwen3-embedding-0.6b'] as const;
type Model = (typeof models)[number];
type Request = (model: Model, input: Record<string, unknown>) => Promise<{ data?: number[][] }>;
export async function runEmbeddingPilot(request: Request) {
  const facts = vectorQualityFacts;
  const documents = facts
    .map((f) => ({ id: f.id, text: `${f.subject} ${f.predicate} ${f.text}` }))
    .concat(
      facts.map((f) => ({
        id: `background-${f.id}`,
        text: f.subject + '的来历记载在镇长的笔记里，相关人物尚未确认。',
      })),
    )
    .concat(
      Array.from({ length: 8 }, (_, i) => ({
        id: `ship-${i}`,
        text: `第${i + 1}号航船今天停靠星港，船员正在清点工具和早餐。`,
      })),
    );
  const cosine = (a: number[], b: number[]) => {
    let dot = 0,
      x = 0,
      y = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      x += a[i]! ** 2;
      y += b[i]! ** 2;
    }
    if (!x || !y) throw new Error('embedding 返回零向量');
    return dot / Math.sqrt(x * y);
  };
  const results = [];
  for (const model of models) {
    const qwen = model.includes('qwen');
    const start = performance.now();
    const d = await request(
      model,
      qwen ? { documents: documents.map((d) => d.text) } : { text: documents.map((d) => d.text) },
    );
    const documentBatchMs = performance.now() - start;
    const queryStart = performance.now();
    const q = await request(
      model,
      qwen
        ? {
            queries: facts.map((f) => f.query),
            instruction:
              'Given a Chinese role-playing story question, retrieve evidence passages that answer it.',
          }
        : { text: facts.map((f) => f.query) },
    );
    const queryBatchMs = performance.now() - queryStart;
    if (d.data?.length !== documents.length || q.data?.length !== facts.length)
      throw new Error(`${model}: embedding 数量不一致`);
    const dimension = d.data[0]!.length;
    if (
      [...d.data, ...q.data].some(
        (v) => v.length !== dimension || !dimension || v.some((n) => !Number.isFinite(n)),
      )
    )
      throw new Error(`${model}: embedding 维度无效`);
    const questions = facts.map((f, i) => {
      const ranked = documents
        .map((doc, j) => ({ id: doc.id, score: cosine(q.data![i]!, d.data![j]!) }))
        .sort((a, b) => b.score - a.score);
      return {
        id: f.id,
        rank: ranked.findIndex((r) => r.id === f.id) + 1,
        top5: ranked.slice(0, 5).map((r) => r.id),
      };
    });
    results.push({
      model,
      dimensions: dimension,
      documentBatchMs,
      queryBatchMs,
      recallAt1: questions.filter((q) => q.rank === 1).length / facts.length,
      recallAt5: questions.filter((q) => q.rank <= 5).length / facts.length,
      recallAt10: questions.filter((q) => q.rank <= 10).length / facts.length,
      mrr: questions.reduce((n, q) => n + 1 / q.rank, 0) / facts.length,
      questions,
    });
  }
  return {
    format: 'lightrp-embedding-pilot-v1',
    measuredAt: new Date().toISOString(),
    corpusDocuments: documents.length,
    questions: facts.length,
    realWorkersAI: true,
    productionIndexChanged: false,
    index: 'exact-cosine-in-memory',
    limitation:
      '20 fixed synthetic questions; batch timings include API overhead; no large RP benchmark or p95 measurement',
    results,
  };
}
async function main() {
  if (!process.argv.includes('--run')) {
    console.log(
      '只读计划：48 条合成语料、20 题、2 个模型、4 次 Workers AI 请求；--run 执行。现有索引不变。',
    );
    return;
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID,
    token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !token)
    throw new Error('需要 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN 环境变量');
  const report = await runEmbeddingPilot(async (model, body) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok) throw new Error(`Workers AI HTTP ${response.status}`);
    const result = (await response.json()) as { success: boolean; result: { data?: number[][] } };
    if (!result.success) throw new Error('Workers AI 请求未成功');
    return result.result;
  });
  await writeFile('reports/embedding-pilot-latest.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      report.results.map(({ questions, ...summary }) => summary),
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
