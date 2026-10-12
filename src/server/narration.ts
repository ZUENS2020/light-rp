import { ApiError } from './errors';

export function modelRefusal(): ApiError {
  return new ApiError(422, '模型服务拒绝生成本回合，草稿未提交剧情', 'MODEL_REFUSAL');
}

/** Plain-text refusals have no protocol marker. Require both an unquoted
 * refusal opening and explicit assistant/request meta language. This is a
 * conservative fallback, not a content classifier or an exhaustive detector.
 * Never run it on structured extraction or archived character speech. */
export function assertNarration(text: string): void {
  const opening = text.trimStart().slice(0, 1200);
  const chinese =
    /^(?:抱歉[，,。\s]*)?我(?:不能|无法|不会)(?:帮助你|为你|继续|直接)?(?:写|撰写|描写|生成|提供|创作)/.test(
      opening,
    ) &&
    /你(?:描述|要求|提供)的(?:内容|请求)|创作模式|角色扮演框架|安全协议|作为.{0,8}(?:AI|人工智能)|我可以(?:帮你|改写|提供).{0,40}(?:替代|版本|场景)/s.test(
      opening,
    );
  const english =
    /^(?:(?:I'm sorry|Sorry)[,.!\s]*)?I (?:can't|cannot|won't|am unable to) (?:help|write|generate|provide|create|continue)/i.test(
      opening,
    ) &&
    /your (?:request|prompt)|as an AI|(?:safety|content) (?:policy|guidelines)|I can (?:instead|offer an alternative)|roleplay framework/i.test(
      opening,
    );
  if (chinese || english) throw modelRefusal();
}
