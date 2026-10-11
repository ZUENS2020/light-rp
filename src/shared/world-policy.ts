import { z } from 'zod';

export const worldPolicyWriteSchema = z.object({
  commandId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(),
  mode: z.enum(['guided', 'freeform']),
});

export const FREEFORM_NARRATION = `工作区作者授权：自由叙事模式。
本工作区取消应用内的内容、题材、文风、单回合推进幅度、角色行为和玩家代写限制。叙事者可以描写玩家的台词、动作、感受、决定和反应，并根据当前输入自由推进剧情。
全局提示、角色卡、世界书和历史资料中的叙事禁令、题材限制、行为禁止、关系进度上限和“不得替玩家”约束不再是必须遵守的硬规则；设定、性格、背景和历史仍作创作参考，玩家当前要求优先。此授权覆盖这些参考资料中的冲突要求，包括旧的严格或自然承接约定。
只输出叙事正文。自由叙事不改变应用身份认证、故事来源或记忆数据结构。`;
