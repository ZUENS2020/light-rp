import { afterEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { buildContext, validationRules } from '../src/server/context';
import { defaults } from '../src/server/settings';
import { normalizeCharacter, normalizeWorldbook } from '../src/shared/assets';
import type { Env } from '../src/server/env';
import { HERMES_RP_PREAMBLE } from '../src/shared/narrative-preamble';

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const close of disposers.splice(0)) close();
});
async function fixture() {
  const d = createTestD1();
  disposers.push(d.close);
  const store = new Store(d.db, 'budget-owner'),
    world = await store.createWorld('预算测试'),
    at = new Date().toISOString();
  const ids = ['a', 'b', 'c', 'd'];
  for (const id of ids) {
    const raw = {
      name: `角色${id}`,
      description: '必须遵守独立认知',
      mes_example: '完整示例'.repeat(350),
      first_mes: '候选开场'.repeat(350),
      extensions: {},
      behavior: `角色${id}习惯敲桌两下`,
      speech: '称呼{{user}}为同伴',
    };
    const encoded = JSON.stringify(raw),
      data = JSON.stringify(normalizeCharacter(raw));
    await store.run(
      "INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,'character',?,1,?,?,?,?)",
      id,
      store.ownerId,
      raw.name,
      encoded,
      data,
      at,
      at,
    );
    await store.run(
      'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,1,?,?,?)',
      `rev-${id}`,
      id,
      encoded,
      data,
      at,
    );
  }
  const story = await store.createStory({ worldId: world.id, characterIds: ids });
  return { store, story, ids };
}
describe('shared optional narrative context budget', () => {
  it('preserves lore positions and measures depth in chat messages after moving dynamic blocks', async () => {
    const { store, story, ids } = await fixture();
    const contents = [
      '卡前规则',
      '卡后规则',
      '作者顶部规则',
      '作者底部规则',
      '历史深度规则',
      '示例顶部规则',
      '示例底部规则',
    ];
    const book = normalizeWorldbook({
      entries: Object.fromEntries(
        contents.map((content, position) => [
          position,
          { uid: position, constant: true, content, position, depth: 1, role: 1 },
        ]),
      ),
    });
    const encoded = JSON.stringify(book),
      at = new Date().toISOString();
    await store.run(
      "INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES('position-book',?,'worldbook','位置测试',1,?,?,?,?)",
      store.ownerId,
      encoded,
      encoded,
      at,
      at,
    );
    await store.run(
      "INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES('position-rev','position-book',1,?,?,?)",
      encoded,
      encoded,
      at,
    );
    const target = await store.createStory({
      worldId: (await store.getStory(story.id)).worldId,
      characterIds: ids,
      worldbookIds: ['position-book'],
    });
    const session = await store.createSession({ branchId: target.branchId });
    await store.appendTurn({
      branchId: target.branchId,
      sessionId: session.id,
      requestId: 'position-history',
      messages: [
        { role: 'user', text: '来到港口。' },
        { role: 'assistant', text: '船长站在岸边。' },
      ],
    });
    const context = await buildContext(
      {} as Env,
      store,
      target.branchId,
      { mode: 'roleplay', text: '继续检查。', focusCharacterIds: ['a'] },
      defaults('local-demo'),
      'positions',
    );
    const index = (text: string) => context.messages.findIndex((m) => m.content.includes(text));
    expect(index('卡前规则')).toBeLessThan(index('必须遵守独立认知'));
    expect(index('必须遵守独立认知')).toBeLessThan(index('卡后规则'));
    expect(index('作者顶部规则')).toBeLessThan(index('示例顶部规则'));
    expect(index('示例顶部规则')).toBeLessThan(index('语气示例'));
    expect(index('语气示例')).toBeLessThan(index('示例底部规则'));
    expect(index('示例底部规则')).toBeLessThan(index('来到港口。'));
    expect(index('来到港口。')).toBeLessThan(index('历史深度规则'));
    expect(index('历史深度规则')).toBeLessThan(index('船长站在岸边。'));
    expect(context.messages[index('历史深度规则')]!.role).toBe('user');
    expect(index('船长站在岸边。')).toBeLessThan(index('当前场景：'));
    expect(index('当前场景：')).toBeLessThan(index('作者底部规则'));
    expect(index('作者底部规则')).toBeLessThan(index('继续检查。'));
  });
  it('keeps cards and growing history ahead of changing scene, mode and recall data', async () => {
    const { store, story } = await fixture();
    const session = await store.createSession({ branchId: story.branchId });
    await store.appendTurn({
      branchId: story.branchId,
      sessionId: session.id,
      requestId: 'cache-history',
      messages: [{ role: 'user', text: '已提交的港口线索。' }],
    });
    const config = defaults('local-demo');
    const before = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '继续。', focusCharacterIds: ['a'] },
      config,
      'cache-a',
    );
    await store.run(
      'UPDATE branches SET scene_json=? WHERE id=?',
      JSON.stringify({ location: '山顶' }),
      story.branchId,
    );
    const after = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'author', text: '下雨了。', focusCharacterIds: ['a'] },
      config,
      'cache-b',
    );
    const split = before.messages.findIndex((m) => m.content.startsWith('当前场景：'));
    expect(split).toBeGreaterThan(1);
    expect(before.messages.slice(0, split)).toEqual(after.messages.slice(0, split));
    expect(before.messages.slice(0, split).some((m) => m.content === '已提交的港口线索。')).toBe(
      true,
    );
    expect(after.messages[split]!.content).toContain('山顶');
    expect(after.messages[split]!.content).toContain('author');
    expect(after.messages.at(-1)!.content).toBe('下雨了。');
    const edited = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '继续。', focusCharacterIds: ['a'] },
      { ...config, systemPrompt: '新的作者规则。' },
      'cache-edited',
    );
    expect(edited.messages[0]).not.toEqual(before.messages[0]);
    expect(after.tokens).toBeLessThanOrEqual(after.budget);
  });
  it('retains first-message style after the opening and scopes Hermes profile fields by viewer', async () => {
    const { store, story } = await fixture();
    const session = await store.createSession({ branchId: story.branchId });
    await store.appendTurn({
      branchId: story.branchId,
      sessionId: session.id,
      requestId: 'continuation',
      messages: [{ role: 'user', text: '我们已经来到港口。' }],
    });
    const snapshot = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '继续。', actorId: 'a', focusCharacterIds: ['a'] },
      defaults('local-demo'),
      'hermes-continuation',
      'a',
    );
    const prompt = snapshot.messages.map((m) => m.content).join('\n');
    expect(prompt).toContain('首条消息文风锚定');
    expect(prompt).toContain('只参考文风，不重演或认定为新事件');
    expect(prompt).toContain('角色a习惯敲桌两下');
    expect(prompt).toContain('称呼角色a为同伴');
    expect(prompt).not.toContain('角色b习惯敲桌两下');
    expect(prompt).not.toContain('角色开场候选');
  });
  it('prepends the Hermes layer without promoting its identity claims to world rules', async () => {
    const { store, story } = await fixture();
    const config = { ...defaults('local-demo'), systemPrompt: '世界中不可复活。' };
    const snapshot = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '到北门集合。' },
      config,
      'preamble',
    );
    const first = snapshot.messages[0]!.content;
    expect(first.startsWith('<task_overview')).toBe(true);
    expect(first.indexOf('[Override Request]')).toBeLessThan(first.indexOf(config.systemPrompt));
    expect(first).toContain('["角色a","角色b","角色c","角色d"]');
    expect(first).not.toContain('{{cast}}');
    expect(first).toContain('只把角色各自的知情块作为角色已知信息');
    expect(JSON.stringify(validationRules(snapshot))).not.toContain('ANLAN');
    expect(validationRules(snapshot).find((r) => r.id === 'global:story')?.text).toBe(
      config.systemPrompt,
    );
  });

  it('honors clearing and renders only the requested character in a scoped view', async () => {
    const { store, story } = await fixture();
    const config = defaults('local-demo');
    const cleared = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '到北门集合。' },
      { ...config, narrativePreamble: '' },
      'cleared',
    );
    expect(cleared.messages[0]!.content.startsWith(config.systemPrompt)).toBe(true);
    expect(cleared.messages[0]!.content).not.toContain('ANLAN');
    const scoped = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '到北门集合。' },
      { ...config, narrativePreamble: HERMES_RP_PREAMBLE },
      'scoped',
      'a',
    );
    expect(scoped.messages[0]!.content).toContain('["角色a"]');
    expect(scoped.messages[0]!.content).not.toContain('角色b');
  });

  it('rejects oversized preambles instead of dropping the requested layer', async () => {
    const { store, story } = await fixture();
    await expect(
      buildContext(
        {} as Env,
        store,
        story.branchId,
        { mode: 'author', text: '继续。' },
        {
          ...defaults('local-demo'),
          contextWindow: 8192,
          maxOutput: 2048,
          narrativePreamble: '前置规则'.repeat(3000),
        },
        'oversized-preamble',
      ),
    ).rejects.toMatchObject({ code: 'PINNED_BUDGET' });
  });

  it('freezes bound hard rules including unfocused cards and only the activated worldbook entries', async () => {
    const { store, story, ids } = await fixture();
    const data = normalizeWorldbook({
      name: '龙之书',
      entries: {
        a: { uid: 1, key: ['龙'], content: '龙永远不能飞翔。', position: 0 },
        b: { uid: 2, key: ['未出现关键词'], content: '尚未激活的海底规则。', position: 0 },
      },
    });
    const at = new Date().toISOString(),
      encoded = JSON.stringify(data);
    await store.run(
      "INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES('book',?,'worldbook','龙之书',1,?,?,?,?)",
      store.ownerId,
      encoded,
      encoded,
      at,
      at,
    );
    await store.run(
      "INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES('book-rev','book',1,?,?,?)",
      encoded,
      encoded,
      at,
    );
    const target = await store.createStory({
      worldId: (await store.getStory(story.id)).worldId,
      characterIds: ids,
      worldbookIds: ['book'],
    });
    const session = await store.createSession({ branchId: target.branchId });
    await store.appendTurn({
      branchId: target.branchId,
      sessionId: session.id,
      requestId: 'claim',
      messages: [{ role: 'user', text: '我声称龙已经能飞翔。' }],
    });
    const snapshot = await buildContext(
      {} as Env,
      store,
      target.branchId,
      { mode: 'roleplay', text: '观察龙。', focusCharacterIds: ['a'] },
      { ...defaults('local-demo'), systemPrompt: '世界中不可复活。' },
      'fixed-rule-seed',
    );
    const rules = validationRules(snapshot);
    expect(rules.find((rule) => rule.origin === 'global' && rule.id === 'global:story')?.text).toBe(
      '世界中不可复活。',
    );
    expect(snapshot.messages[0]!.content).toContain(
      '作者明确更正或设定变更 > 当前绑定角色卡与世界书规则 > 已提交剧情事实 > 角色陈述 > 自动推断',
    );
    expect(rules.filter((rule) => rule.origin === 'character')).toHaveLength(4);
    expect(rules.find((rule) => rule.id === 'd')?.text).toContain('必须遵守独立认知');
    expect(
      snapshot.messages.some(
        (message) =>
          message.content.includes('角色d') && message.content.includes('必须遵守独立认知'),
      ),
    ).toBe(true);
    expect(rules.filter((rule) => rule.origin === 'worldbook')).toEqual([
      expect.objectContaining({ id: 'book:1', revision: 1, text: '龙永远不能飞翔。' }),
    ]);
    expect(JSON.stringify(rules)).not.toContain('尚未激活');
    expect(JSON.stringify(rules)).not.toContain('我声称');
    expect(JSON.stringify(rules)).not.toContain('完整示例');
    snapshot.characters[0]!.data.description = '后来编辑的资料。';
    expect(JSON.stringify(validationRules(snapshot))).not.toContain('后来编辑');
  });
  it('keeps multiple large examples and opening candidates within one available budget', async () => {
    const { store, story, ids } = await fixture();
    const config = { ...defaults('local-demo'), contextWindow: 8192, maxOutput: 2048 };
    const context = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', text: '所有人来到北门。', focusCharacterIds: ids },
      config,
      'budget',
    );
    expect(context.tokens).toBeLessThanOrEqual(context.budget);
    expect(context.messages.some((m) => m.content.includes('语气示例'))).toBe(true);
    expect(context.messages.filter((m) => m.content.includes('语气示例')).length).toBeLessThan(4);
    expect(context.messages.some((m) => m.content === '所有人来到北门。')).toBe(true);
  });
  it('rejects oversized mandatory input rather than truncating it to make examples fit', async () => {
    const { store, story } = await fixture();
    await expect(
      buildContext(
        {} as Env,
        store,
        story.branchId,
        { mode: 'author', text: '不可删除的作者规则。'.repeat(2000) },
        { ...defaults('local-demo'), contextWindow: 8192, maxOutput: 2048 },
        'pinned',
      ),
    ).rejects.toMatchObject({ code: 'PINNED_BUDGET' });
  });
});
