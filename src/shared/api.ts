import { z } from 'zod';
import { playerProfileSchema } from './player';
/** Public v3 write contracts. Identity and transactional fences remain server enforced. */
export const storySchema = z.object({
  worldId: z.string(),
  title: z.string().optional(),
  name: z.string().optional(),
  characterIds: z.array(z.string()).max(50).default([]),
  worldbookIds: z.array(z.string()).max(50).default([]),
  playerCharacterId: z.string().optional(),
  playerProfile: playerProfileSchema.optional(),
});
export const playerProfileWriteSchema = z.object({
  commandId: z.string().min(8).max(150),
  expectedHead: z.number().int().min(0),
  profile: playerProfileSchema,
});
export const forkSchema = z.object({
  eventSeq: z.number().int().min(0),
  name: z.string().max(200).optional(),
});
export const resourcesSchema = z.object({ assetIds: z.array(z.string()).max(100) });
export const correctionSchema = z.object({
  commandId: z.string().min(8).max(200).optional(),
  expectedHead: z.number().int().min(0).optional(),
  memoryId: z.string().optional(),
  subjectId: z.string().optional(),
  predicate: z.string().optional(),
  text: z.string().trim().min(1).max(20000),
  value: z.json().optional(),
});
export const procedureStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'retired', 'draft']),
  commandId: z.string().min(8).max(200).optional(),
  expectedHead: z.number().int().min(0).optional(),
});
export const rebuildSchema = z.object({
  commandId: z.string().min(8).max(200),
  expectedHead: z.number().int().min(0),
});
export const threadWriteSchema = z.object({
  commandId: z.string().min(8).max(200),
  expectedHead: z.number().int().min(0),
  memoryId: z.string(),
  state: z.enum(['open', 'progressing', 'blocked', 'resolved', 'abandoned']),
  title: z.string().min(1).max(250),
  completion: z.string().min(1).max(1000),
  text: z.string().trim().min(1).max(2000),
});
export const archiveRebuildSchema = rebuildSchema.extend({ memoryId: z.string() });
export const turnSchema = z.object({
  commandId: z.string().min(8).max(200),
  expectedHead: z.number().int().min(0),
  sessionId: z.string(),
  input: z.object({
    mode: z.enum(['roleplay', 'author']),
    text: z.string().trim().min(1).max(100000),
    actorId: z.string().optional(),
  }),
  focusCharacterIds: z.array(z.string()).max(50).optional(),
});
export const decisionModels = ['@cf/cloudflare/clef', '@cf/cloudflare/clef-flash'] as const;
export const settingsSchema = z
  .object({
    provider: z.string().min(1).default('workers-ai'),
    model: z.string().min(1).default('@cf/qwen/qwen3-30b-a3b-fp8'),
    auxiliaryModel: z.string().default(''),
    decisionModel: z.enum(['', ...decisionModels]).default(''),
    narrativePreamble: z.string().max(20000).default(''),
    baseUrl: z.string().default('https://api.openai.com/v1'),
    contextWindow: z.number().int().min(4096).max(2000000).default(32768),
    maxOutput: z.number().int().min(128).max(65536).default(4096),
    auxiliaryMaxOutput: z
      .number()
      .int()
      .min(0)
      .max(65536)
      .refine((value) => value === 0 || value >= 128, '辅助输出上限至少为128，或设为0沿用正文上限')
      .default(0),
    systemPrompt: z
      .string()
      .max(40000)
      .default('你是统一叙事者。维护人物动机、各自知情边界和世界规则，不替玩家决定行为。'),
    mode: z.enum(['gateway', 'openai', 'local-demo']).default('gateway'),
  })
  .refine(
    (s) => Math.max(s.maxOutput, s.auxiliaryMaxOutput || s.maxOutput) + 1024 < s.contextWindow,
    '正文或辅助输出预留超过上下文容量',
  );
export type ModelSettings = z.infer<typeof settingsSchema>;

export const apiWriteSchemas = {
  story: storySchema,
  playerProfile: playerProfileWriteSchema,
  fork: forkSchema,
  resources: resourcesSchema,
  correction: correctionSchema,
  procedureStatus: procedureStatusSchema,
  rebuild: rebuildSchema,
  thread: threadWriteSchema,
  archiveRebuild: archiveRebuildSchema,
  turn: turnSchema,
  settings: settingsSchema,
} as const;
export function publicApiSchemas() {
  return Object.fromEntries(
    Object.entries(apiWriteSchemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { unrepresentable: 'any' }),
    ]),
  );
}
export type StoryRequest = z.infer<typeof storySchema>;
export type ForkRequest = z.infer<typeof forkSchema>;
export type ResourcesRequest = z.infer<typeof resourcesSchema>;
export type CorrectionRequest = z.infer<typeof correctionSchema>;
export type ProcedureStatusRequest = z.infer<typeof procedureStatusSchema>;
export type RebuildRequest = z.infer<typeof rebuildSchema>;
export type TurnRequest = z.infer<typeof turnSchema>;
