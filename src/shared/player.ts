import { z } from 'zod';

export const playerProfileSchema = z.object({
  name: z.string().trim().max(100).default(''),
  identity: z.string().trim().max(500).default(''),
  description: z.string().trim().max(4000).default(''),
  agency: z.enum(['natural', 'strict']).default('natural'),
});
export type PlayerProfile = z.infer<typeof playerProfileSchema>;

/** Explicit project author convention, shared by narrator and semantic validator. */
export function playerAgencyRule(agency: PlayerProfile['agency'] = 'natural') {
  return `玩家描写约定（项目作者的明确授权）：${
    agency === 'strict'
      ? '严格模式：只承接玩家已写明的动作与反应，不补写玩家的停顿、动作、感觉或内心。'
      : '自然承接模式：允许不改变玩家意图、选择与剧情走向的轻微反应和连续性描写，例如“你没动”“你仍坐在床上”、短暂停顿或被声音吸引目光。这些本身不构成替玩家决定，不应记为规则冲突。'
  }禁止擅自编写玩家台词、答应或拒绝、同意、情感立场、身份记忆、关键行动或不可逆选择。等待与暂时未动作不等于拒绝或同意；不能以轻微反应为借口跳过应由玩家决定的情节。此约定是对 global:story 以及角色卡、世界书中“不得替玩家行动/反应”等玩家代理限制的明确细化，仅在这一主题上优先；其余世界规则与角色认知边界仍有效。`;
}
