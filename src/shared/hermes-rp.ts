/** Adapted from NEC's Hermes build_soul_md: scene continuity, player agency,
 * voice anchoring and pacing. The ANLAN preamble remains separately editable. */
export const HERMES_NARRATIVE_GUIDANCE = `你是统一叙事者，演绎当前故事中的多位角色，以中文互动小说正文回答。

玩家与作者：角色扮演模式中，玩家的动作、台词、决定和内心由玩家提供；只承接已明确写出的行为，不替玩家补写反应。作者模式中的开头、背景、时间跳转和调度按明确指示落实，不把作者说明变成角色听见的话。接续已有开头时，从末尾当前时刻继续，不重演开场。

人物：按每张卡的性格、行为习惯、语气和背景分别演绎。人物有自己的目标、判断与底线；不要让所有人使用同样的口癖或无条件迎合玩家。用恰当的动作、停顿和细节表达情绪与潜台词；不必逐句配动作或每次写完整心理报告。

连续性：延续最新已提交的地点、姿势、衣物、伤势、持有物、关系与情绪。身体特征仅来自明确角色设定及已提交变化，不按名字或关键词猜测。状态变化要有动作、时间或事件依据；物品不会凭空转移，衣物不会自动复原，人物不会瞬移。情绪需要过渡；已确立的关系从当前阶段继续，不退回陌生期。

知情：导演可见的世界事实不等于每位角色所知。角色的台词与判断只依据其亲历、告知和已有认知；误信可以影响行为，不能自动改写客观真相。其他人物不能获知未公开的内心独白。

文风：以角色开场和示例对话为语气、节奏与描写密度的参考；示例与开场范本不是新发生的事件。日常简洁，冲突与情感处适当放慢，避免每回合固定长篇或机械配比。优先遵守当前作者对视角、篇幅和格式的明确要求。默认用*动作与神态*、\"对白\"表现场景，内心描写适量且符合视角。

输出：只写本回合正文，结尾给玩家留出行动空间。不附状态栏、模板元标签、工具日志或写作说明；应用侧的人物与场景面板负责展示状态。`;

/** Hermes JSON/YAML-specific fields stay in the original card. Read only
 * explicitly supplied values; do not infer anatomy or turn tags into facts. */
export function hermesCharacterProfile(raw: unknown): Record<string, string | string[]> {
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const wrapper = record(raw);
  const data = Object.hasOwn(wrapper, 'data') ? record(wrapper.data) : wrapper;
  const result: Record<string, string | string[]> = {};
  for (const [name, aliases] of Object.entries({
    age: ['age', 'Age'],
    gender: ['gender', 'sex', 'Sex', 'Gender'],
    behavior: ['behavior', 'Behavior'],
    speech: ['speech', 'Speech'],
    likes: ['likes', 'Likes'],
    dislikes: ['dislikes', 'Dislikes'],
    backstory: ['backstory', 'Backstory'],
  })) {
    const key = aliases.find((alias) => Object.hasOwn(data, alias));
    const value = key ? data[key] : undefined;
    if (typeof value === 'string' && value.trim()) result[name] = value;
    else if (Array.isArray(value)) {
      const values = value.filter((v): v is string => typeof v === 'string' && !!v.trim());
      if (values.length) result[name] = values;
    }
  }
  return result;
}
