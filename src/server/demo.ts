import { Store, now, uuid } from './store';
import { importAsset } from '../shared/assets';
import type { Evidence } from '../shared/domain';
/** Only the loopback demo endpoint calls this. All evidence is labelled as a fixture. */
export async function seedDemo(s: Store) {
  const world = await s.createWorld({
    name: '黄铜门 · 演示世界',
    description: '固定示范数据，用于检查认知、分支和技能生命周期。',
  });
  const characters: string[] = [];
  for (const [name, description] of [
    ['林舟', '熟悉机械锁，善于观察。只知道亲历与被告知的内容。'],
    ['苏弥', '谨慎的档案员，不知道林舟的内心与秘密。'],
  ]) {
    const id = uuid(),
      at = now(),
      raw = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name,
          description,
          personality: '谨慎、独立',
          scenario: '北门前',
          first_mes: '门后似乎有声音。',
          mes_example: '',
          system_prompt: '遵守角色所知范围。',
          extensions: {},
        },
      };
    const asset = importAsset(new TextEncoder().encode(JSON.stringify(raw)), `${name}.json`);
    await s.batch([
      {
        sql: 'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
        params: [
          id,
          s.ownerId,
          'character',
          name,
          JSON.stringify(raw),
          JSON.stringify(asset.data),
          at,
          at,
        ],
      },
      {
        sql: 'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,1,?,?,?)',
        params: [uuid(), id, JSON.stringify(raw), JSON.stringify(asset.data), at],
      },
    ]);
    characters.push(id);
  }
  const [lin, su] = characters as [string, string];
  const story = await s.createStory({
    worldId: world.id,
    name: '黄铜门 · 生命周期演示',
    characterIds: characters,
    playerCharacterId: lin,
  });
  const branchId = story.branchId,
    session = await s.createSession({ branchId, name: '演示第一幕' });
  const append = async (text: string, role: 'assistant' | 'correction' = 'assistant') => {
    const result = await s.appendTurn({
      branchId,
      sessionId: session.id,
      requestId: uuid(),
      messages: [{ role, text, knownBy: [] }],
      scene: { location: '北门', time: '清晨', present: characters },
    });
    const event = result.events[0]!;
    return {
      event,
      evidence: {
        sourceId: event.sourceId,
        start: 0,
        end: Array.from(text).length,
        quote: text,
      } satisfies Evidence,
    };
  };
  const secret = await append('【演示原文】蓝钥匙确实藏在仓库。林舟没有告诉苏弥。');
  await s.grantKnowledge({
    branchId,
    sourceId: secret.event.sourceId,
    characterId: lin,
    quote: secret.evidence.quote,
    channel: 'witnessed',
  });
  await s.propose(branchId, {
    kind: 'canon',
    subject: '蓝钥匙',
    predicate: 'location',
    value: '仓库',
    text: '蓝钥匙在仓库',
    knownBy: [lin],
    evidence: [secret.evidence],
  });
  const lie = await append('【演示原文】林舟对苏弥说：“蓝钥匙在码头。”苏弥相信了这句话。');
  await s.grantKnowledge({
    branchId,
    sourceId: lie.event.sourceId,
    characterId: su,
    quote: lie.evidence.quote,
    channel: 'told',
  });
  await s.propose(branchId, {
    kind: 'belief',
    subject: '蓝钥匙',
    predicate: 'location',
    value: '码头',
    text: '苏弥相信蓝钥匙在码头',
    observerId: su,
    knownBy: [su],
    evidence: [lie.evidence],
  });
  const learning = await append('【演示作者设定】林舟已经学会用黄铜钥匙开启北门。', 'correction');
  await s.grantKnowledge({
    branchId,
    sourceId: learning.event.sourceId,
    characterId: lin,
    quote: learning.evidence.quote,
    channel: 'author',
  });
  await s.addCapability({
    branchId,
    actorId: lin,
    name: '黄铜钥匙开门',
    level: '熟练',
    evidence: [learning.evidence],
  });
  for (const n of [1, 2]) {
    const attempt = await append(
      `【演示独立尝试 ${n}】林舟把黄铜钥匙插入北门锁孔，顺时针转动；北门成功打开。`,
    );
    await s.grantKnowledge({
      branchId,
      sourceId: attempt.event.sourceId,
      characterId: lin,
      quote: attempt.evidence.quote,
      channel: 'witnessed',
    });
    await s.addExperience({
      branchId,
      actorId: lin,
      capability: '黄铜钥匙开门',
      conditions: { 工具: '黄铜钥匙', 对象: '北门', 锁状态: '完好' },
      steps: ['插入黄铜钥匙', '顺时针转动'],
      outcome: 'success',
      evidence: [attempt.evidence],
    });
  }
  const events = await s.getEvents(branchId);
  await s.extract(branchId, {
    eventIds: events.map((e) => e.id),
    proposals: [],
    cursor: events.at(-1)?.seq ?? 0,
    extractorVersion: 'v3-facts',
  });
  return {
    story,
    branch: await s.getBranch(branchId),
    session,
    notice: '固定示范数据；未调用模型，不代表模型抽取评测。',
  };
}
