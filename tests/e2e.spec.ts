import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { zlibSync } from 'fflate';
import {
  compressedCardChunk,
  importAsset,
  normalizeWorldbook,
  readPngChunks,
  writePngChunks,
  type JsonObject,
} from '../src/shared/assets';

const prefix = '/api/v3';
const unique = () => `验收${Date.now()}${Math.floor(Math.random() * 1000)}`;
async function json(
  request: APIRequestContext,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  data?: unknown,
) {
  const response = await request[method](`${prefix}${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `${method.toUpperCase()} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function findCharacter(request: APIRequestContext, name: string) {
  let cursor = '';
  do {
    const page = await json(
      request,
      'get',
      `/assets?kind=character&cursor=${encodeURIComponent(cursor)}`,
    );
    const asset = page.items.find((entry: any) => entry.name === name);
    if (asset) return asset;
    cursor = page.nextCursor || '';
  } while (cursor);
  throw new Error(`角色不存在：${name}`);
}
async function awaitTask(request: APIRequestContext, id: string) {
  await expect
    .poll(async () => (await json(request, 'get', `/tasks/${id}`)).status, {
      timeout: 60_000,
      intervals: [100, 250, 500, 1000],
    })
    .toBe('completed');
  return json(request, 'get', `/tasks/${id}`);
}
async function send(page: Page, request: APIRequestContext, text: string) {
  await page.getByLabel('输入剧情', { exact: true }).fill(text);
  const response = page.waitForResponse(
    (r) => r.url().includes('/turns') && r.request().method() === 'POST',
  );
  await page.getByLabel('输入剧情', { exact: true }).press('Control+Enter');
  const result = await response;
  expect(result.ok(), await result.text()).toBeTruthy();
  const task = await result.json();
  await awaitTask(request, task.taskId);
  await expect(page.getByRole('button', { name: '发送剧情', exact: true })).toBeVisible();
  return task.taskId;
}
function pngCard(card: JsonObject) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.from(
    writePngChunks([
      { type: 'IHDR', data: ihdr },
      { type: 'tEXt', data: new TextEncoder().encode('Author\0original') },
      { type: 'IDAT', data: zlibSync(new Uint8Array(5)) },
      compressedCardChunk('ccv3', card),
      { type: 'IEND', data: new Uint8Array() },
    ]),
  );
}

test.beforeEach(async ({ request }) => {
  const settings = await json(request, 'get', '/settings');
  await json(request, 'put', '/settings', { ...settings, mode: 'local-demo' });
});

test('角色 PNG 往返保留原图和未知扩展，资料编辑与触发预览访问真实后端', async ({
  page,
  request,
}, info) => {
  const name = `${unique()}船长`;
  const card: JsonObject = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    vendor: { retained: true },
    data: {
      name,
      description: '原始描述',
      personality: '谨慎，留心每个承诺。',
      first_mes: '雾散了。',
      mes_example: '船长：沿岸走。',
      extensions: { future: { number: 42 } },
    },
  };
  const originalPNG = pngCard(card);
  await page.goto('/');
  await page.getByRole('button', { name: /资料库/ }).click();
  await page
    .getByLabel('导入资料文件')
    .setInputFiles({ name: 'captain.png', mimeType: 'image/png', buffer: originalPNG });
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  const initial = await findCharacter(request, name);
  expect(initial.hasPng).toBe(true);
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `编辑 · ${name}` });
  await expect(dialog.getByLabel('人物描述', { exact: true })).toHaveValue('原始描述');
  await expect(dialog.getByRole('button', { name: '保存版本', exact: true })).toBeEnabled();
  await dialog.getByLabel('人物描述', { exact: true }).fill('新的描述：喜欢记录每次航行。');
  await dialog.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const revised = await json(request, 'get', `/assets/${initial.id}`);
  expect(revised.revision).toBe(initial.revision + 1);
  expect(revised.raw.vendor).toEqual({ retained: true });
  expect(revised.raw.data.extensions).toEqual({ future: { number: 42 } });
  expect(revised.raw.data.description).toBe('新的描述：喜欢记录每次航行。');
  const stale = await request.patch(`${prefix}/assets/${initial.id}`, {
    data: { expectedRevision: initial.revision, patch: { data: { name: '不应保存' } } },
  });
  expect(stale.status()).toBe(409);
  await page.getByRole('button', { name, exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'PNG', exact: true }).click();
  const downloaded = await downloadEvent;
  const stream = await downloaded.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const output = Buffer.concat(chunks);
  expect(importAsset(output, 'export.png').raw).toEqual(revised.raw);
  expect(readPngChunks(output).find((chunk) => chunk.type === 'IDAT')?.data).toEqual(
    readPngChunks(originalPNG).find((chunk) => chunk.type === 'IDAT')?.data,
  );
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: /^世界书/ }).click();
  await page.getByRole('button', { name: '新建世界书', exact: true }).click();
  const book = page.getByRole('dialog', { name: '新建世界书' });
  await book.getByLabel('名称', { exact: true }).fill(`${name}港口设定`);
  await book.getByRole('button', { name: '添加条目', exact: true }).click();
  await book.getByLabel('条目名称', { exact: true }).fill('港口灯塔');
  await book.getByLabel('关键词', { exact: true }).fill('港口');
  await book.getByLabel('内容', { exact: true }).fill('港口有一座白色灯塔。');
  await book.getByRole('button', { name: '触发预览', exact: true }).click();
  await book.getByLabel('测试文本', { exact: true }).fill('我们走进港口。');
  await book.getByRole('button', { name: '服务端触发预览', exact: true }).click();
  await expect(book.locator('.server-preview')).toContainText('港口有一座白色灯塔。');
  await book.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(book).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath('library-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('多角色故事流式生成、续聊、作者版本、分支隔离和全分支来源删除', async ({
  page,
  request,
}, info) => {
  const name = unique();
  const a = await json(request, 'post', '/assets', {
    kind: 'character',
    data: {
      name: `${name}晴岚`,
      description: '谨慎的船长',
      personality: '温和而坚持原则',
      first_mes: '雾港就在前面。',
    },
  });
  const b = await json(request, 'post', '/assets', {
    kind: 'character',
    data: { name: `${name}林舟`, description: '随行的测绘师', personality: '好奇，话少' },
  });
  const lore = await json(request, 'post', '/assets', {
    kind: 'worldbook',
    data: {
      name: `${name}雾港`,
      entries: [
        {
          id: 'lighthouse',
          keys: ['灯塔'],
          content: '灯塔每晚为归航船点亮。',
          enabled: true,
          insertion_order: 1,
        },
      ],
    },
  });
  const bootstrap = await json(request, 'get', '/bootstrap');
  await page.goto('/');
  await page.locator('.new-story').click();
  const storyDialog = page.getByRole('dialog', { name: '新建故事' });
  await storyDialog.getByLabel('故事标题', { exact: true }).fill(`${name}归航`);
  await storyDialog.getByText(a.name, { exact: true }).click();
  await storyDialog.getByText(b.name, { exact: true }).click();
  await storyDialog.getByText(lore.name, { exact: true }).click();
  await storyDialog.getByLabel('玩家角色', { exact: true }).selectOption(b.id);
  await storyDialog.getByRole('button', { name: '创建故事', exact: true }).click();
  await expect(storyDialog).not.toBeVisible();
  await expect(page.getByLabel('输入剧情', { exact: true })).toBeEnabled();
  const story = (await json(request, 'get', '/bootstrap')).stories.find(
    (s: any) => s.name === `${name}归航`,
  );
  expect(story.characterIds).toEqual([a.id, b.id]);
  expect(story.worldbookIds).toEqual([lore.id]);
  expect(story.worldId).toBe(bootstrap.worlds[0].id);
  const parent = (await json(request, 'get', `/stories/${story.id}/branches`))[0];
  await send(page, request, '我们来到灯塔前，商量下一次航行。');
  await expect(page.locator('.narration .prose')).toContainText('本地流程演示');
  const parentAfterTurn = await json(request, 'get', `/branches/${parent.id}`);
  expect(parentAfterTurn.events).toHaveLength(2);
  await expect
    .poll(
      async () =>
        (await json(request, 'get', `/branches/${parent.id}/compression`)).find(
          (state: any) => state.scope === 'director:archive',
        )?.throughSeq,
    )
    .toBe(2);
  // A slow read must remain displayable while background snapshots change.
  const branchRoute = `**${prefix}/branches/${parent.id}`;
  const archiveRoute = `**${prefix}/branches/${parent.id}/archive*`;
  let projectedRefresh = 0;
  await page.route(branchRoute, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.branch.projectionRevision += ++projectedRefresh;
    await route.fulfill({ response, json: body });
  });
  await page.route(archiveRoute, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.fulfill({ response });
  });
  await page.getByRole('tab', { name: '归档', exact: true }).click();
  await expect(page.locator('.memory-record').first()).toContainText('局部片段');
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await page.unrouteAll({ behavior: 'wait' });
  const completedTask = parentAfterTurn.jobs.find((job: any) => job.status === 'completed');
  expect(completedTask).toBeTruthy();
  await page.getByRole('button', { name: '上下文', exact: true }).click();
  let actualContext = page.getByRole('dialog', { name: '上下文检查器' });
  const actualRequest = page.waitForResponse((response) =>
    response.url().endsWith(`/tasks/${completedTask.id}/context`),
  );
  await actualContext.getByLabel('上下文来源', { exact: true }).selectOption(completedTask.id);
  const actualSnapshot = await (await actualRequest).json();
  expect(
    actualSnapshot.messages.some(
      (message: any) => message.content === '我们来到灯塔前，商量下一次航行。',
    ),
  ).toBe(true);
  await expect(actualContext.getByText('本回合实际上下文', { exact: true })).toBeVisible();
  await expect(actualContext.getByLabel('检索内容', { exact: true })).toBeDisabled();
  await actualContext.getByLabel('上下文来源', { exact: true }).selectOption('preview');
  await expect(actualContext.getByLabel('检索内容', { exact: true })).toBeEnabled();
  await actualContext.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  const sessionDialog = page.getByRole('dialog', { name: '新建会话' });
  await sessionDialog.getByLabel('会话标题', { exact: true }).fill('翌日');
  await sessionDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(sessionDialog).not.toBeVisible();
  await send(page, request, '翌日，我们继续昨天在灯塔前的计划。');
  const parentContinued = await json(request, 'get', `/branches/${parent.id}`);
  expect(parentContinued.events).toHaveLength(4);
  expect(new Set(parentContinued.events.map((e: any) => e.sessionId)).size).toBe(2);
  await page.getByRole('button', { name: '添加作者设定', exact: true }).click();
  let authorDialog = page.getByRole('dialog', { name: '添加作者设定' });
  await authorDialog.getByLabel('作者设定', { exact: true }).fill('雾港灯塔的守塔人叫沈墨。');
  await authorDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(authorDialog).not.toBeVisible();
  await expect(
    page.locator('.memory-record').filter({ hasText: '雾港灯塔的守塔人叫沈墨。' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '查看分支树', exact: true }).click();
  await page
    .getByRole('dialog', { name: '故事分支' })
    .getByRole('button', { name: '从当前回合分叉', exact: true })
    .click();
  const forkDialog = page.getByRole('dialog', { name: '建立平行分支' });
  await forkDialog.getByLabel('分支名称', { exact: true }).fill('平行航线');
  await forkDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(forkDialog).not.toBeVisible();
  await expect(page.getByLabel('当前分支', { exact: true })).toContainText('平行航线');
  await expect(page.getByLabel('输入剧情', { exact: true })).toBeEnabled();
  const child = (await json(request, 'get', `/stories/${story.id}/branches`)).find(
    (branch: any) => branch.name === '平行航线',
  );
  expect(child.parentBranchId).toBe(parent.id);
  await expect(
    page.locator('.memory-record').filter({ hasText: '雾港灯塔的守塔人叫沈墨。' }),
  ).toBeVisible();
  const originalRecord = page
    .locator('.memory-record')
    .filter({ hasText: '雾港灯塔的守塔人叫沈墨。' })
    .first();
  await originalRecord.getByRole('button', { name: /^纠正/ }).click();
  authorDialog = page.getByRole('dialog', { name: '作者纠正' });
  await authorDialog.getByLabel('正确的信息', { exact: true }).fill('这条航线的守塔人改名为沈青。');
  await authorDialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(authorDialog).not.toBeVisible();
  const childSnapshot = await json(request, 'get', `/branches/${child.id}`);
  const corrected = childSnapshot.memories.find(
    (m: any) => m.status === 'active' && m.text === '这条航线的守塔人改名为沈青。',
  );
  expect(corrected.supersedesId).toBeTruthy();
  const parentSnapshot = await json(request, 'get', `/branches/${parent.id}`);
  expect(
    parentSnapshot.memories.some(
      (m: any) => m.status === 'active' && m.text === '雾港灯塔的守塔人叫沈墨。',
    ),
  ).toBe(true);
  expect(parentSnapshot.memories.some((m: any) => m.text === corrected.text)).toBe(false);
  await page
    .locator('.memory-record')
    .filter({ hasText: corrected.text })
    .first()
    .getByRole('button', { name: '来源', exact: true })
    .click();
  const historyDialog = page.getByRole('dialog', { name: '来源与证据' });
  await historyDialog.getByText('版本历史与纠正记录', { exact: true }).click();
  await expect(historyDialog.locator('.memory-version')).toHaveCount(2);
  await expect(historyDialog.locator('.memory-version').first()).toContainText('已被新版本替代');
  await expect(historyDialog.locator('.memory-version').last()).toContainText('作者明确纠正');
  await historyDialog.getByRole('button', { name: '查看 v1 原文', exact: true }).click();
  await expect(historyDialog.locator('.evidence-event')).toContainText('雾港灯塔的守塔人叫沈墨。');
  await historyDialog.getByRole('button', { name: '查看 v2 原文', exact: true }).click();
  await expect(historyDialog.locator('.evidence-event')).toContainText(corrected.text);
  await historyDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '上下文', exact: true }).click();
  const contextDialog = page.getByRole('dialog', { name: '上下文检查器' });
  await contextDialog.getByLabel('检索内容', { exact: true }).fill('守塔人 灯塔');
  await contextDialog.getByRole('button', { name: '重新召回', exact: true }).click();
  await expect(contextDialog.locator('.context-recall')).toContainText('沈青');
  await contextDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('studio-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.inspector')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '打开检查器', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: info.outputPath('studio-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '打开检查器', exact: true }).click();
  const original = parentSnapshot.memories.find(
    (m: any) => m.text === '雾港灯塔的守塔人叫沈墨。' && m.status === 'active',
  );
  await page.getByLabel('当前分支', { exact: true }).selectOption(parent.id);
  await expect(page.locator('.memory-record').filter({ hasText: original.text })).toBeVisible();
  await page
    .locator('.memory-record')
    .filter({ hasText: original.text })
    .first()
    .getByRole('button', { name: '来源', exact: true })
    .click();
  const evidence = page.getByRole('dialog', { name: '来源与证据' });
  await expect(evidence.locator('.evidence-event')).toContainText(original.text);
  await evidence.getByRole('button', { name: '删除原文', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除原文来源' })
    .getByRole('button', { name: '确认删除原文来源', exact: true })
    .click();
  await expect(evidence).not.toBeVisible();
  for (const id of [parent.id, child.id]) {
    const memories = (await json(request, 'get', `/branches/${id}`)).memories;
    expect(memories.some((m: any) => m.id === original.id && m.status === 'active')).toBe(false);
    const deleted = await request.get(`${prefix}/branches/${id}/sources/${original.sourceIds[0]}`);
    expect([404, 410]).toContain(deleted.status());
  }
  const archive = await json(request, 'get', `/branches/${child.id}/export`);
  expect(archive.format).toBe('lightrp-story');
  expect(archive.branches).toHaveLength(2);
});

test('明确的演示故事通过真实经验规则自动启用，能停用、重新启用并查看证据', async ({
  page,
  request,
}, info) => {
  const seed = await json(request, 'post', '/demo');
  await page.goto('/');
  const bootstrap = await json(request, 'get', '/bootstrap');
  const story = bootstrap.stories.find((s: any) => s.id === (seed.storyId || seed.story?.id));
  expect(story).toBeTruthy();
  await page.locator(`[data-story-id="${story.id}"]`).click();
  await expect(page.getByLabel('输入剧情', { exact: true })).toBeEnabled();
  await expect(page.locator('.scene-content')).not.toContainText('{');
  await page.getByRole('tab', { name: '经验', exact: true }).click();
  await expect(page.locator('.skill-evidence-count').first()).toContainText('2 次独立成功证据');
  const skill = page
    .locator('.memory-record')
    .filter({ has: page.locator('.skill-evidence-count') })
    .first();
  await expect(skill.locator('.procedure-explanation')).toContainText('由已提交案例自动启用');
  await skill.getByRole('button', { name: '停用', exact: true }).click();
  await expect(skill.getByRole('button', { name: '重新启用', exact: true })).toBeEnabled();
  await expect(skill.locator('.procedure-explanation')).toContainText('作者手动暂停');
  await skill.getByRole('button', { name: '重新启用', exact: true }).click();
  await expect(skill.getByRole('button', { name: '停用', exact: true })).toBeVisible();
  await expect(skill.locator('.procedure-explanation')).toContainText('作者重新启用');
  await expect(page.locator('.transcript')).not.toContainText('状态设为');
  await skill.getByRole('button', { name: '来源', exact: true }).click();
  const snapshot = await json(request, 'get', `/branches/${seed.branch.id}`);
  const procedure = snapshot.procedures.find((p: any) => p.status === 'active');
  await expect(
    page.getByRole('dialog', { name: '来源与证据' }).locator('.evidence-event'),
  ).toHaveCount(procedure.sourceIds.length);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({
    path: info.outputPath('procedural-memory.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const rebuildRequest = page.waitForRequest(
    (request) =>
      request.url().includes(`/branches/${seed.branch.id}/rebuild`) && request.method() === 'POST',
  );
  await page.getByRole('button', { name: '重建记忆', exact: true }).click();
  const rebuild = await rebuildRequest;
  expect(rebuild.postDataJSON()).toMatchObject({ expectedHead: snapshot.branch.headSeq });
  expect(rebuild.postDataJSON().commandId).toMatch(/^[a-f0-9-]{36}$/i);
  await expect(page.locator('.toast')).toContainText('记忆重建已排队');
});

test('重新生成先创建分支，保留原稿和原始玩家身份', async ({ page, request }) => {
  const name = unique();
  const character = await json(request, 'post', '/assets', {
    kind: 'character',
    data: { name: `${name}叙岚`, description: '来自海边的访客', personality: '细心' },
  });
  const bootstrap = await json(request, 'get', '/bootstrap');
  const story = await json(request, 'post', '/stories', {
    worldId: bootstrap.worlds[0].id,
    title: `${name}重写`,
    characterIds: [character.id],
    playerCharacterId: character.id,
  });
  await page.goto('/');
  await page.locator(`[data-story-id="${story.id}"]`).click();
  await expect(page.getByLabel('输入剧情', { exact: true })).toBeEnabled();
  const parent = (await json(request, 'get', `/stories/${story.id}/branches`))[0];
  const input = '我向北门守卫出示昨日的通行证。';
  await send(page, request, input);
  const original = await json(request, 'get', `/branches/${parent.id}`);
  expect(original.events[0].speakerId).toBe(character.id);
  // Change composer identity to prove regenerate takes the recorded input's identity.
  await page.getByLabel('玩家身份', { exact: true }).selectOption('');
  const response = page.waitForResponse(
    (r) => r.url().includes('/turns') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '重新生成回合2', exact: true }).click();
  const turn = await (await response).json();
  await awaitTask(request, turn.taskId);
  await expect(page.getByRole('button', { name: '发送剧情', exact: true })).toBeVisible();
  const branches = await json(request, 'get', `/stories/${story.id}/branches`);
  expect(branches).toHaveLength(2);
  const child = branches.find((branch: any) => branch.parentBranchId === parent.id);
  expect(child.forkSeq).toBe(0);
  const rewritten = await json(request, 'get', `/branches/${child.id}`);
  expect(rewritten.events).toHaveLength(2);
  expect(rewritten.events[0]).toMatchObject({ text: input, speakerId: character.id });
  expect(
    (await json(request, 'get', `/branches/${parent.id}`)).events.map((event: any) => event.id),
  ).toEqual(original.events.map((event: any) => event.id));
  expect(rewritten.events[1].id).not.toBe(original.events[1].id);
});

test('模型连接测试使用当前未保存配置，演示模式明确不验证远程模型', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('运行模式', { exact: true }).selectOption('local-demo');
  await page.getByLabel('提供方标识', { exact: true }).fill('workers-ai');
  const request = page.waitForRequest(
    (request) => request.url().endsWith('/settings/probe') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    mode: 'local-demo',
    provider: 'workers-ai',
  });
  await expect(page.getByRole('status')).toContainText('未调用远程模型');
});

test('正文与辅助校验输出预算独立保存，辅助设为0后沿用正文预算', async ({ page, request }) => {
  const original = await json(request, 'get', '/settings');
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('上下文窗口（token）', { exact: true }).fill('131072');
    await page.getByLabel('模型输出上限（token）', { exact: true }).fill('16000');
    await page.getByLabel('记忆与剧情校验输出上限（token）', { exact: true }).fill('32768');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('模型配置已保存');
    expect(await json(request, 'get', '/settings')).toMatchObject({
      contextWindow: 131072,
      maxOutput: 16000,
      auxiliaryMaxOutput: 32768,
    });
    await page.reload();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByLabel('记忆与剧情校验输出上限（token）', { exact: true })).toHaveValue(
      '32768',
    );
    await page.getByLabel('记忆与剧情校验输出上限（token）', { exact: true }).fill('0');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect
      .poll(async () => (await json(request, 'get', '/settings')).auxiliaryMaxOutput)
      .toBe(0);
  } finally {
    await json(request, 'put', '/settings', original);
  }
});

test('Hermes 前置层可编辑、保存、明确清空，并用于实际上下文', async ({ page, request }, info) => {
  const original = await json(request, 'get', '/settings');
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '载入 Hermes 头部', exact: true }).click();
    await expect(page.getByLabel('叙事前置层', { exact: true })).toHaveValue(/ANLAN/);
    await page.getByRole('button', { name: '载入 Hermes 叙事指引', exact: true }).click();
    await expect(page.getByLabel('叙事指引', { exact: true })).toHaveValue(/连续性：/);
    const custom = '沉浸叙事前置段：当前角色 {{cast}}，保持各自认知。';
    await page.getByLabel('叙事前置层', { exact: true }).fill(custom);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('模型配置已保存');
    expect((await json(request, 'get', '/settings')).narrativePreamble).toBe(custom);
    const boot = await json(request, 'get', '/bootstrap');
    const card = await json(request, 'post', '/assets', {
      kind: 'character',
      data: { name: `${unique()}前置层角色`, description: '谨慎的守卫' },
    });
    const story = await json(request, 'post', '/stories', {
      worldId: boot.worlds[0].id,
      characterIds: [card.id],
      title: unique(),
    });
    const context = await json(request, 'get', `/branches/${story.branchId}/context?query=集合`);
    expect(context.messages[0].content).toContain('沉浸叙事前置段：当前角色');
    expect(context.messages[0].content).toContain(card.name);
    expect(context.messages[0].content).not.toContain('{{cast}}');
    expect(context.messages[0].content).toContain('连续性：');
    expect(context.messages[0].content).toContain('不重演开场');
    await page.getByRole('button', { name: '清空前置层', exact: true }).click();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect
      .poll(async () => (await json(request, 'get', '/settings')).narrativePreamble)
      .toBe('');
    await page.reload();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByLabel('叙事前置层', { exact: true })).toHaveValue('');
    const cleared = await json(request, 'get', `/branches/${story.branchId}/context?query=集合`);
    expect(cleared.messages[0].content).not.toContain('沉浸叙事前置段：');
    await page.getByRole('button', { name: '载入 Hermes 头部', exact: true }).click();
    await page.screenshot({
      path: info.outputPath('hermes-preamble-settings.png'),
      fullPage: true,
      animations: 'disabled',
    });
  } finally {
    await json(request, 'put', '/settings', original);
  }
});

test('角色设定能力可编辑和明确清空，PNG 与未知扩展完整保留', async ({ page, request }) => {
  const name = `${unique()}能力角色`;
  const card: JsonObject = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: '一位经验丰富的领航员。',
      extensions: {
        future: { number: 42 },
        lightrp: {
          preserved: { color: 'blue' },
          capabilities: [{ name: '航海', level: '熟练', certificate: '未识别的条目扩展' }],
        },
      },
    },
  };
  await page.goto('/');
  await page.getByRole('button', { name: /资料库/ }).click();
  await page
    .getByLabel('导入资料文件')
    .setInputFiles({ name: 'capabilities.png', mimeType: 'image/png', buffer: pngCard(card) });
  await page.getByRole('button', { name, exact: true }).click();
  let dialog = page.getByRole('dialog', { name: `编辑 · ${name}` });
  await expect(dialog.getByLabel('能力名称 1', { exact: true })).toHaveValue('航海');
  await expect(dialog.locator('.capability-editor')).toContainText(
    '召回一个方法不会让角色获得能力',
  );
  await dialog.getByLabel('能力级别 1', { exact: true }).fill('专家');
  await dialog.getByRole('button', { name: '添加能力', exact: true }).click();
  await dialog.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('每项角色能力需要填写名称');
  await dialog.getByLabel('能力名称 2', { exact: true }).fill('解锁');
  await dialog.getByLabel('能力级别 2', { exact: true }).fill('初级');
  await dialog.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const asset = await findCharacter(request, name);
  const revised = await json(request, 'get', `/assets/${asset.id}`);
  expect(revised.raw.data.extensions).toEqual({
    future: { number: 42 },
    lightrp: {
      preserved: { color: 'blue' },
      capabilities: [
        { name: '航海', level: '专家', certificate: '未识别的条目扩展' },
        { name: '解锁', level: '初级' },
      ],
    },
  });
  await page.getByRole('button', { name, exact: true }).click();
  dialog = page.getByRole('dialog', { name: `编辑 · ${name}` });
  await expect(dialog.getByLabel('能力名称 2', { exact: true })).toHaveValue('解锁');
  await dialog.getByRole('button', { name: '删除能力2', exact: true }).click();
  await dialog.getByRole('button', { name: '删除能力1', exact: true }).click();
  await dialog.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const cleared = await json(request, 'get', `/assets/${asset.id}`);
  expect(cleared.raw.data.extensions.lightrp.capabilities).toEqual([]);
  expect(cleared.raw.data.extensions.lightrp.preserved).toEqual({ color: 'blue' });
  expect(cleared.raw.data.extensions.future).toEqual({ number: 42 });
  const png = await request.get(`${prefix}/assets/${asset.id}/export?format=png`);
  expect(png.ok()).toBe(true);
  expect(importAsset(await png.body(), 'cleared.png').raw).toEqual(cleared.raw);
  await page.getByRole('button', { name, exact: true }).click();
  dialog = page.getByRole('dialog', { name: `编辑 · ${name}` });
  await expect(dialog.locator('.capability-entry')).toHaveCount(0);
});

test('世界书高级选项编辑实际生效且保留未知扩展', async ({ page, request }) => {
  const name = `${unique()}世界书`;
  const asset = await json(request, 'post', '/assets', {
    kind: 'worldbook',
    data: {
      spec: 'lorebook_v3',
      spec_version: '3.0',
      data: {
        name,
        token_budget: 70,
        scan_depth: 2,
        recursive_scanning: false,
        entries: [
          {
            id: 'harbor',
            keys: ['港口'],
            secondary_keys: ['潮汐'],
            selective: true,
            insertion_order: 23,
            content: '港口每晚会点亮航标。',
            extensions: {
              position: 4,
              depth: 7,
              role: 1,
              selectiveLogic: 0,
              ignore_budget: false,
              future: { retained: true },
            },
          },
        ],
      },
    },
  });
  let releaseLoad: () => void = () => undefined;
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let readCount = 0;
  await page.route(`**/api/v3/assets/${asset.id}`, async (route) => {
    if (route.request().method() === 'GET') {
      readCount++;
      if (readCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '测试资料暂时不可读' } }),
        });
        return;
      }
      if (readCount === 2) await loadGate;
    }
    await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /资料库/ }).click();
  await page.getByRole('button', { name: /^世界书/ }).click();
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `编辑 · ${name}` });
  await expect(dialog.getByRole('alert')).toContainText('测试资料暂时不可读');
  await expect(dialog.getByLabel('世界书预算（token）', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存版本', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(dialog.getByText('读取原始字段与扩展…', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('世界书预算（token）', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '保存版本', exact: true })).toBeDisabled();
  releaseLoad();
  await expect(dialog.getByLabel('注入顺序', { exact: true })).toHaveValue('23');
  await expect(dialog.getByLabel('历史深度', { exact: true })).toHaveValue('7');
  await dialog.getByLabel('世界书预算（token）', { exact: true }).fill('120');
  await dialog.getByLabel('扫描深度', { exact: true }).fill('5');
  await dialog.getByLabel('递归扫描已触发条目', { exact: true }).check();
  await dialog.getByLabel('注入顺序', { exact: true }).fill('99');
  await dialog.getByLabel('触发优先级', { exact: true }).fill('33');
  await dialog.getByLabel('历史深度', { exact: true }).fill('3');
  await dialog.getByLabel('次级关键词', { exact: true }).fill('码头');
  await dialog.getByText('匹配与递归设置', { exact: true }).click();
  await expect(dialog.getByLabel('消息角色', { exact: true })).toHaveValue('user');
  await dialog.getByLabel('消息角色', { exact: true }).selectOption('assistant');
  await dialog.getByLabel('次级匹配逻辑', { exact: true }).selectOption('3');
  await dialog.getByLabel('忽略此世界书预算（仍受本回合总预算限制）', { exact: true }).check();
  await dialog.getByLabel('不触发其他条目', { exact: true }).check();
  await dialog.getByLabel('条目扫描深度', { exact: true }).fill('9');
  await dialog.getByRole('button', { name: '保存版本', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const revised = await json(request, 'get', `/assets/${asset.id}`);
  const projected = normalizeWorldbook(revised.raw);
  expect(projected).toMatchObject({ tokenBudget: 120, scanDepth: 5, recursiveScanning: true });
  expect(projected.entries[0]).toMatchObject({
    position: 'at-depth',
    role: 'assistant',
    depth: 3,
    order: 99,
    priority: 33,
    selectiveLogic: 3,
    secondaryKeys: ['码头'],
    ignoreBudget: true,
    preventRecursion: true,
    scanDepth: 9,
  });
  expect(revised.raw.data.entries[0].extensions.future).toEqual({ retained: true });
});

test('作者设定响应丢失后重试复用幂等键和预期版本，不重复提交事件', async ({ page, request }) => {
  const name = unique();
  const bootstrap = await json(request, 'get', '/bootstrap');
  const story = await json(request, 'post', '/stories', {
    worldId: bootstrap.worlds[0].id,
    title: `${name}作者重试`,
    characterIds: [],
  });
  const branch = (await json(request, 'get', `/stories/${story.id}/branches`))[0];
  await page.goto('/');
  await page.locator(`[data-story-id="${story.id}"]`).click();
  await expect(page.getByLabel('输入剧情', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '添加作者设定', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加作者设定' });
  const posted: any[] = [];
  await page.route(`**/api/v3/branches/${branch.id}/corrections`, async (route) => {
    posted.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (posted.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ response });
  });
  await dialog.getByLabel('作者设定', { exact: true }).fill('蓝钥匙存放在仓库。');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const committed = await json(request, 'get', `/branches/${branch.id}`);
  expect(committed.events).toHaveLength(1);
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(posted).toHaveLength(2);
  expect(posted[0].commandId).toMatch(/^[a-f0-9-]{36}$/i);
  expect(posted[0].expectedHead).toBe(branch.headSeq);
  expect(posted[1]).toEqual(posted[0]);
  const retried = await json(request, 'get', `/branches/${branch.id}`);
  expect(retried.events.map((event: any) => event.id)).toEqual(
    committed.events.map((event: any) => event.id),
  );
  await expect(
    page.locator('.memory-record').filter({ hasText: '蓝钥匙存放在仓库。' }),
  ).toBeVisible();
});

test('玩家身份在新故事设定，编辑后跨会话沿用并保留分叉时的身份', async ({ page, request }) => {
  const world = await json(request, 'post', '/worlds', { name: unique() });
  await page.goto('/');
  await page.locator('.new-story').click();
  const creation = page.getByRole('dialog', { name: '新建故事' });
  await creation.getByLabel('故事标题', { exact: true }).fill(unique());
  await creation.getByLabel('所属世界', { exact: true }).selectOption(world.id);
  await creation.getByLabel('身份 / 职业', { exact: true }).fill('特雷森学园训练员');
  await creation.getByLabel('玩家背景', { exact: true }).fill('刚在医务室醒来，仍然失忆。');
  await creation.getByRole('button', { name: '创建故事', exact: true }).click();
  await expect(creation).not.toBeVisible();
  await page.getByRole('button', { name: '设定身份', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设定玩家身份' });
  await expect(dialog.getByLabel('身份 / 职业', { exact: true })).toHaveValue('特雷森学园训练员');
  await dialog.getByLabel('玩家姓名', { exact: true }).fill('林');
  await dialog.getByLabel('玩家描写方式', { exact: true }).selectOption('strict');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/player-profile') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '保存身份', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
  const result = await response.json();
  await expect(dialog).not.toBeVisible();
  const branchId = result.branch.id;
  const child = await json(request, 'post', `/branches/${branchId}/forks`, {
    eventSeq: 1,
    name: '原始训练员',
  });
  const childId = child.id || child.branch?.id;
  expect(
    (await json(request, 'get', `/branches/${childId}`)).branch.scene.playerProfile.identity,
  ).toBe('特雷森学园训练员');
  await json(request, 'post', `/branches/${branchId}/sessions`, { title: '第二幕' });
  await page.reload();
  await send(page, request, '我看着窗外，等她开口。');
  await page.getByRole('button', { name: '设定身份', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '设定玩家身份' }).getByLabel('玩家姓名', { exact: true }),
  ).toHaveValue('林');
  const context = await json(request, 'get', `/branches/${branchId}/context`);
  expect(context.messages[0].content).toContain('特雷森学园训练员');
  expect(context.messages[0].content).toContain('严格模式');
});

test('长聊天首次到底、流式跟随和向上阅读不被打断，消息来源与历史页明确', async ({
  page,
  request,
}, info) => {
  // Control incoming content to interleave large chunks with actual wheel/keyboard input.
  // Other cases exercise the real Worker SSE; this case isolates viewport behaviour.
  const world = await json(request, 'post', '/worlds', { name: unique() });
  const story = await json(request, 'post', '/stories', { worldId: world.id, title: unique() });
  const branch = (await json(request, 'get', `/stories/${story.id}/branches`))[0];
  const original = await json(request, 'get', `/branches/${branch.id}`);
  const sessionId = original.sessions[0].id;
  const taskId = 'ui-scroll-task';
  const makeEvents = (start: number) =>
    Array.from({ length: 24 }, (_, i) => ({
      id: `scroll-${start + i}`,
      seq: start + i,
      sessionId,
      role: i === 2 ? 'correction' : i % 2 === 0 ? 'user' : 'assistant',
      text:
        i === 2
          ? '作者确认：这里是一座临海小城。'
          : i % 2 === 0
            ? `我留意街角第 ${i + 1} 盏灯，停下来听听风声。`
            : `第 ${i + 1} 幕。街道尽头的灯光慢慢亮起来，路边的人收起雨伞，继续向前走。\n\n她回过头，等着你的下一句话。`,
    }));
  await page.route(`**/api/v3/branches/${branch.id}*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const before = new URL(route.request().url()).searchParams.get('beforeSeq');
    await route.fulfill({
      json: {
        ...original,
        branch: {
          ...original.branch,
          headSeq: 2024,
          scene: { playerProfile: { name: '林', identity: '训练员' } },
        },
        events: makeEvents(before ? 1 : 2001),
        eventsBeforeSeq: before ? Number(before) : null,
        hasEarlierEvents: !before,
      },
    });
  });
  await page.route(`**/api/v3/tasks/${taskId}`, (route) =>
    route.fulfill({ json: { id: taskId, status: 'running', attempt: 1 } }),
  );
  await page.addInitScript(
    ({ storyId, branchId, taskId }) => {
      localStorage.setItem('lightrp.story', storyId);
      localStorage.setItem(`lightrp.branch.${storyId}`, branchId);
      localStorage.setItem(`lightrp.task.${branchId}`, taskId);
      const sources: EventTarget[] = [];
      class ControlledSource extends EventTarget {
        constructor(_url: string | URL) {
          super();
          sources.push(this);
        }
        close() {
          const at = sources.indexOf(this);
          if (at >= 0) sources.splice(at, 1);
        }
      }
      window.EventSource = ControlledSource as unknown as typeof EventSource;
      (window as any).pushStoryChunk = (kind: string, value: unknown) => {
        sources.forEach((source) =>
          source.dispatchEvent(new MessageEvent(kind, { data: JSON.stringify(value) })),
        );
      };
    },
    { storyId: story.id, branchId: branch.id, taskId },
  );
  await page.goto('/');
  const viewport = page.getByLabel('故事正文', { exact: true });
  const distance = () =>
    viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  const push = (text: string) =>
    page.evaluate((text) => (window as any).pushStoryChunk('delta', { attempt: 1, text }), text);
  await expect(
    page.locator('.story-event[data-sender="player"]').first().locator('strong'),
  ).toHaveText('你');
  await expect(page.locator('.story-event[data-sender="player"]').first()).toContainText('林');
  await expect(page.locator('.story-event[data-sender="ai"]').first().locator('strong')).toHaveText(
    'AI 叙事',
  );
  await expect(page.locator('.story-event[data-sender="author"]').locator('strong')).toHaveText(
    '作者纠正',
  );
  const playerBox = await page.locator('.story-event[data-sender="player"]').first().boundingBox();
  const aiBox = await page.locator('.story-event[data-sender="ai"]').first().boundingBox();
  expect(playerBox!.x).toBeGreaterThan(aiBox!.x + 20);
  await expect.poll(distance).toBeLessThan(2);
  const toolbarY = (await page.locator('.story-toolbar').boundingBox())!.y;
  await push('她看向街灯，慢慢讲起那段旧事。\n'.repeat(60));
  await expect(page.locator('.live-event .prose')).toContainText('旧事');
  await expect.poll(distance).toBeLessThan(2);
  await viewport.hover();
  await page.mouse.wheel(0, -650);
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  const readingTop = await viewport.evaluate((node) => node.scrollTop);
  await push('路上的人渐渐散去，风吹过空荡的台阶。\n'.repeat(45));
  await expect(
    page.getByRole('button', { name: '有新内容 · 回到最新', exact: true }),
  ).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(readingTop, 0);
  // The ordinary 5s snapshot refresh must also preserve the reader's position.
  await page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v3/branches/${branch.id}`);
  expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(readingTop, 0);
  await page.getByRole('button', { name: '有新内容 · 回到最新', exact: true }).click();
  await expect.poll(distance).toBeLessThan(2);
  await push('她停了停，等你继续。\n'.repeat(35));
  await expect.poll(distance).toBeLessThan(2);
  expect((await page.locator('.story-toolbar').boundingBox())!.y).toBe(toolbarY);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Keyboard navigation and changing width behave like wheel scrolling.
  await viewport.focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看更早正文', exact: true }).click();
  await expect(page.getByRole('button', { name: '返回最新剧情', exact: true })).toBeVisible();
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(2);
  await page.screenshot({
    path: info.outputPath('chat-senders-desktop.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '返回最新剧情', exact: true }).click();
  await expect.poll(distance).toBeLessThan(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.inspector')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '打开检查器', exact: true })).toBeVisible();
  await expect.poll(distance).toBeLessThan(2);
  expect(await viewport.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await viewport.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(2);
  await page.screenshot({
    path: info.outputPath('chat-senders-mobile.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  await page.evaluate(() =>
    (window as any).pushStoryChunk('terminal', {
      status: 'failed',
      error: { message: '测试草稿尚未提交' },
      draftText: '保存的草稿第一段。'.repeat(500),
    }),
  );
  await expect(page.getByText('查看保存的草稿', { exact: true })).toBeVisible();
  await expect.poll(distance).toBeLessThan(2);
  const draftTop = await viewport.evaluate((node) => node.scrollTop);
  await page.getByText('查看保存的草稿', { exact: true }).click();
  await expect.poll(distance).toBeGreaterThan(1000);
  expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(draftTop, 0);
});
