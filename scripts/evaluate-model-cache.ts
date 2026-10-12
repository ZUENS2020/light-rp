import { writeFile } from 'node:fs/promises';
import { createTestD1 } from '../tests/d1';
import { Store } from '../src/server/store';
import { buildContext } from '../src/server/context';
import {
  complete,
  promptCacheUsage,
  type ChatMessage,
  type PromptCacheUsage,
} from '../src/server/model';
import { defaults } from '../src/server/settings';
import { normalizeCharacter } from '../src/shared/assets';
import { playerAgencyRule } from '../src/shared/player';
import type { Env } from '../src/server/env';

// Opt-in, synthetic-only live probe. No story, identity, API key or full model
// response is written to the report. No preview resources are read or modified.
const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error('Set MODEL_API_KEY in the environment for this opt-in live probe');
const db = createTestD1();
try {
  const store = new Store(db.db, 'synthetic-cache-evaluation');
  const world = await store.createWorld('合成缓存测试世界');
  const at = new Date().toISOString();
  const raw = {
    name: '海图管理员',
    description: Array.from(
      { length: 80 },
      (_, i) =>
        `档案${i + 1}：管理员保管第${i + 1}号海图，图上记录第${i + 1}座灯塔与第${i + 1}条航线。每张图的借阅记录独立保存；未经告知的人物不知道借阅者身份。`,
    ).join('\n'),
    personality: '冷静，仔细核对海图编号，不替玩家决定航程。',
  };
  const encoded = JSON.stringify(raw),
    data = JSON.stringify(normalizeCharacter(raw));
  await store.run(
    "INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES('cartographer',?,'character',?,1,?,?,?,?)",
    store.ownerId,
    raw.name,
    encoded,
    data,
    at,
    at,
  );
  await store.run(
    "INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES('card-rev','cartographer',1,?,?,?)",
    encoded,
    data,
    at,
  );
  const story = await store.createStory({ worldId: world.id, characterIds: ['cartographer'] });
  const session = await store.createSession({ branchId: story.branchId });
  const config = {
    ...defaults('local-demo'),
    contextWindow: 32768,
    maxOutput: 2048,
    systemPrompt: `合成缓存测试 ${crypto.randomUUID()}。只输出“好”，不解释，不思考。`,
  };
  const contexts: ChatMessage[][] = [];
  for (let i = 0; i < 3; i++) {
    await store.run(
      'UPDATE branches SET scene_json=? WHERE id=?',
      JSON.stringify({ location: `码头${i + 1}`, time: `下午${i + 1}时` }),
      story.branchId,
    );
    contexts.push(
      (
        await buildContext(
          {} as Env,
          store,
          story.branchId,
          {
            mode: 'roleplay',
            text: `检查第${i + 1}号海图。只输出“好”。`,
            focusCharacterIds: ['cartographer'],
          },
          config,
          'synthetic-cache',
        )
      ).messages,
    );
    await store.appendTurn({
      branchId: story.branchId,
      sessionId: session.id,
      requestId: `synthetic-${i}`,
      messages: [
        { role: 'user', text: `检查第${i + 1}号海图。只输出“好”。` },
        { role: 'assistant', text: '管理员核对了海图。' },
      ],
    });
  }
  const settings = {
    ...config,
    mode: 'openai' as const,
    provider: 'commandcode',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: process.env.CACHE_EVAL_MODEL || 'deepseek/deepseek-v4.1-flash',
  };
  const rows: {
    layout: string;
    request: number;
    elapsedMs: number;
    outcome: string;
    usage: PromptCacheUsage;
  }[] = [];
  for (const layout of ['scene-first-baseline', 'stable-prefix']) {
    for (let i = 0; i < contexts.length; i++) {
      let messages = contexts[i]!;
      if (layout === 'scene-first-baseline') {
        const live = messages.find((m) => m.content.startsWith('当前场景：'))!;
        messages = messages
          .filter((m) => m !== live)
          .map((m, j) =>
            j === 0
              ? {
                  ...m,
                  content: m.content.replace(
                    playerAgencyRule('natural'),
                    `${live.content}\n\n${playerAgencyRule('natural')}`,
                  ),
                }
              : m,
          );
      }
      const start = Date.now();
      let usage = promptCacheUsage({}),
        outcome = 'completed';
      try {
        await complete({ MODEL_API_KEY: apiKey } as Env, settings, messages, {
          signal: AbortSignal.timeout(60000),
          onText: async () => undefined,
          onUsage: (rawUsage) => {
            usage = promptCacheUsage(rawUsage);
          },
        });
      } catch (error) {
        outcome =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : 'FAILED';
      }
      const row = { layout, request: i + 1, elapsedMs: Date.now() - start, outcome, usage };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    synthetic: true,
    model: settings.model,
    note: 'Three sequential changing-scene requests per layout; baseline reconstructs the previous scene-first core. Synthetic long card, not a production hit-rate guarantee. Prefix persistence and routing are provider controlled.',
    rows,
  };
  const output = process.argv[2];
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (rows.some((r) => r.outcome !== 'completed' || r.usage.cacheHitRate === null))
    process.exitCode = 1;
} finally {
  db.close();
}
