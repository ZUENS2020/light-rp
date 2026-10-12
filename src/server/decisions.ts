import { z } from 'zod';
import type { Env } from './env';
import { ApiError } from './errors';
import { boundedText } from './model';
import { estimateAssetTokens } from '../shared/assets';
import { decisionModels } from '../shared/api';

export { decisionModels } from '../shared/api';
export type DecisionModel = (typeof decisionModels)[number];
export const decisionModelSchema = z.enum(decisionModels);
export const decisionQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: z.string().trim().min(1).max(4000),
});
const questionsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), decisionQuestionSchema)
  .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 64, '需要1–64个问题');
export type DecisionQuestions = z.infer<typeof questionsSchema>;
const answerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const resultSchema = z.object({
  model: z.enum(['clef', 'clef-flash']),
  answers: z.record(z.string(), answerSchema),
  usage: z
    .object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) })
    .optional(),
});
/** Conservative development thresholds. These are not a calibrated guarantee. */
export function decisionVerdict(probability: number): 'supported' | 'rejected' | 'uncertain' {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new ApiError(502, '决策模型返回无效概率', 'DECISION_RESPONSE');
  return probability >= 0.9 ? 'supported' : probability <= 0.1 ? 'rejected' : 'uncertain';
}
/** Decisions supplement evidence validation; a probability never creates a grant,
 * upgrades source authority, resurrects a source, or replaces a commit fence. */
export async function runDecisionQuestions(
  env: Env,
  model: DecisionModel,
  state: Record<string, unknown>,
  questions: DecisionQuestions,
  options: {
    signal?: AbortSignal;
    onUsage?: (usage: { input_tokens: number; output_tokens: number }) => void;
  } = {},
) {
  decisionModelSchema.parse(model);
  questionsSchema.parse(questions);
  const selector = model === decisionModels[0] ? 'clef' : 'clef-flash';
  const payload = { model: selector, state, questions };
  // Clef can silently truncate long state: reject it before the network instead.
  // The lower application cap leaves room for its question encoding and template.
  const serialized = JSON.stringify(payload);
  if (
    serialized.length > 200000 ||
    new TextEncoder().encode(serialized).byteLength > 48000 ||
    estimateAssetTokens(serialized) > 24000
  )
    throw new ApiError(422, '完整判断资料超过预算，请减少候选或证据范围', 'DECISION_BUDGET');
  if (options.signal?.aborted) throw options.signal.reason;
  const start = performance.now();
  let raw: unknown;
  try {
    raw = await env.AI.run(model as keyof AiModels, payload as never, {
      signal: options.signal,
      gateway: { id: env.AI_GATEWAY_ID, skipCache: true, collectLog: false },
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new ApiError(502, '决策模型暂不可用，保留候选并重试', 'DECISION_UNAVAILABLE');
  }
  if (options.signal?.aborted) throw options.signal.reason;
  if (raw instanceof Response) {
    if (!raw.ok) {
      await raw.body?.cancel();
      throw new ApiError(502, '决策模型暂不可用，保留候选并重试', 'DECISION_UNAVAILABLE');
    }
    try {
      raw = JSON.parse(await boundedText(raw, 65536));
    } catch {
      throw new ApiError(502, '决策模型返回无效结构', 'DECISION_RESPONSE');
    }
  }
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.model !== selector)
    throw new ApiError(502, '决策模型返回无效结构', 'DECISION_RESPONSE');
  const expected = Object.keys(questions).sort();
  if (JSON.stringify(Object.keys(parsed.data.answers).sort()) !== JSON.stringify(expected))
    throw new ApiError(502, '决策模型问题与回答不完整匹配', 'DECISION_RESPONSE');
  const result = parsed.data;
  if (result.usage) options.onUsage?.(result.usage);
  return {
    model,
    protocol: 'system-one-noul-v1' as const,
    thresholdVersion: 'development-0.9-0.1-v1' as const,
    answers: Object.fromEntries(
      expected.map((id) => [
        id,
        {
          probability: result.answers[id]!.noul,
          verdict: decisionVerdict(result.answers[id]!.noul),
        },
      ]),
    ),
    usage: result.usage ?? null,
    latencyMs: performance.now() - start,
  };
}
