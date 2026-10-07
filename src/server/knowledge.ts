import { z } from 'zod';
import { ApiError } from './errors';
import type { EntityCharacter, StoryEntity } from './entities';

/** Model output is a claim about acquisition, never an authorization itself. */
export const knowledgeProofSchema = z.object({
  actorId: z.string().min(1),
  source: z.enum(['user', 'assistant']),
  channel: z.enum(['witnessed', 'told', 'rumor', 'inferred']),
  quote: z.string().min(1).max(4000),
});
export type KnowledgeProof = z.infer<typeof knowledgeProofSchema>;
export interface KnowledgeCandidate {
  evidence: { source: 'user' | 'assistant'; quote: string }[];
  knowledge?: KnowledgeProof[];
  observerId?: string;
  actorId?: string;
}
export interface KnowledgeActor {
  id: string;
  aliases: string[];
}
export function knowledgeActors(
  characters: EntityCharacter[],
  entities: StoryEntity[] = [],
): KnowledgeActor[] {
  const roster = characters.map((character) => ({
    id: character.id,
    aliases: [
      ...new Set(
        [
          character.id,
          character.data.name,
          character.data.nickname,
          ...(character.data.aliases ?? []),
          ...(entities.find((entity) => entity.id === character.id)?.aliases ?? []),
        ].filter((value): value is string => !!value?.trim()),
      ),
    ],
  }));
  // An ambiguous name is not evidence of which identically named person heard it.
  return roster.map((actor) => ({
    ...actor,
    aliases: actor.aliases.filter(
      (alias) => !roster.some((other) => other.id !== actor.id && other.aliases.includes(alias)),
    ),
  }));
}
export function actorsFromEntities(entities: StoryEntity[]): KnowledgeActor[] {
  return knowledgeActors(
    entities
      .filter((entity) => entity.kind === 'character')
      .map((entity) => ({
        id: entity.id,
        data: { name: entity.name, aliases: entity.aliases },
      })),
    entities,
  );
}
const fail = (reason: string): never => {
  throw new ApiError(422, `知情证据无效：${reason}`, 'KNOWLEDGE_PROOF_INVALID');
};
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function identity(actor: KnowledgeActor): string {
  return `(?:${actor.aliases
    .map((alias) =>
      /^[\w-]+$/u.test(alias) ? `(?<![\\w-])${escape(alias)}(?![\\w-])` : escape(alias),
    )
    .join('|')})`;
}
const privateState =
  /(?:心想|内心|心中|暗想|默想|心底|心里|独自想|无人知道|无人知晓|导演秘密|旁白秘密|仅导演|无人察觉|没有人知道|private thought|inner thought|secretly thought)/iu;
const nonActual =
  /(?:声称|宣称|谎称|自称|想象|设想|梦见|梦到|假设|假如|如果|倘若|若是|一旦|计划|打算|希望|以为|声称|可能|也许|据说|传闻|不知道是否|是否|claimed|imagined|supposed|planned|if\s)/iu;

/** Sentence boundaries inside a character's quotation are not narration
 * boundaries. Keep the outer attribution while masking quoted acquisitions. */
function narrativeClauses(
  source: string,
): { start: number; end: number; raw: string; objective: string }[] {
  const clauses: { start: number; end: number; raw: string; objective: string }[] = [];
  const stack: string[] = [];
  let start = 0,
    objective = '';
  const emit = (end: number, next = end + 1) => {
    if (source.slice(start, end).trim())
      clauses.push({ start, end, raw: source.slice(start, end), objective });
    start = next;
    objective = '';
  };
  for (let at = 0; at < source.length; at++) {
    const c = source[at]!,
      close = ({ '“': '”', '「': '」', '『': '』', '‘': '’' } as Record<string, string>)[c];
    if (stack.at(-1) === c && (!['"', "'"].includes(c) || source[at - 1] !== '\\')) {
      stack.pop();
      objective += ' ';
      if (!stack.length && /[。！？；\n]/u.test(source[at - 1] ?? '')) emit(at + 1, at + 1);
      continue;
    }
    if (close || (['"', "'"].includes(c) && source[at - 1] !== '\\')) {
      stack.push(close ?? c);
      objective += ' ';
      continue;
    }
    if (!stack.length && /[。！？；\n]/u.test(c)) emit(at);
    else objective += stack.length ? ' ' : c;
  }
  emit(source.length);
  return clauses;
}

/** Inspect the whole source clause, not an attacker-chosen positive substring
 * from e.g. "甲没有告诉乙...". Quote offsets are UTF-16 here, resolved to the
 * canonical code-point source span only after this check. */
function containingClauses(source: string, quote: string) {
  const start = source.indexOf(quote);
  if (start < 0 || source.indexOf(quote, start + 1) >= 0) return fail('获知原句不存在或不唯一');
  return narrativeClauses(source).filter(
    (clause) => clause.start < start + quote.length && clause.end > start,
  );
}
function deniesAcquisition(clause: string, actor: KnowledgeActor): boolean {
  const name = identity(actor);
  return (
    new RegExp(
      `${name}[\\s，,:：]*(?:实际上|其实|最初|起初|此前|始终|仍然|至今|当时|在远处|现在)?(?:并没有|没有|并未|从未|尚未|未曾|还没|没|不|未)[^。！？；\\n]{0,6}(?:听|看|知|得|获|明白|理解|被告知|hear|see|know)`,
      'iu',
    ).test(clause) ||
    new RegExp(
      `(?:没有|并未|从未|尚未|未曾|没|不|未)[^。！？；\\n]{0,12}(?:告诉|告知|通知|传达给|向|对)[^。！？；\\n]{0,8}${name}`,
      'iu',
    ).test(clause) ||
    new RegExp(
      `${name}[^。！？；\\n]{0,16}(?:是否|能否)[^。！？；\\n]{0,16}(?:未知|未确认|不确定|unknown)`,
      'iu',
    ).test(clause) ||
    new RegExp(
      `${name}[^。！？；\\n]{0,16}(?:unaware|did not hear|didn't hear|did not know)`,
      'iu',
    ).test(clause)
  );
}
function positiveAcquisition(
  clause: string,
  actor: KnowledgeActor,
  channel: KnowledgeProof['channel'],
  ownExperience = false,
): boolean {
  const name = identity(actor),
    own =
      channel === 'witnessed'
        ? '(?:亲眼|亲耳|明确|已经|确实|清楚|也|终于|直接|现在|仔细|当场|正在|能|曾)?(?:看到|看见|目睹|见证|听到|听见|听清|获知|得知|知道|知晓|意识到|heard|saw|learned)'
        : channel === 'inferred'
          ? '(?:明确|已经|确实|终于)?(?:推断|推测|猜出|inferred)'
          : '(?:明确|已经|确实|清楚|终于|亲耳)?(?:听到|听见|听清|听说|获知|得知|知道|知晓|heard|learned)';
  const subject = new RegExp(`${name}[\\s，,:：]*(?:从[^。！？；\\n]{1,16})?${own}`, 'iu');
  const actual = (pattern: RegExp) => {
    const match = pattern.exec(clause);
    return (
      !!match &&
      !nonActual.test(clause.slice(0, match.index)) &&
      !/(?:说|表示|提到)[：:，,]?\s*$/u.test(clause.slice(0, match.index)) &&
      !/(?:说|表示|提到)[：:]|(?:说|表示|提到)(?:自己|我|他|她)/u.test(
        clause.slice(0, match.index),
      ) &&
      !/(?:尚未确认|未确认|不确定|是否.*未知|只是.*猜测|是.*猜测|只是.*计划|并未发生|没有发生)/u.test(
        clause.slice(match.index),
      )
    );
  };
  if (actual(subject)) return true;
  if (ownExperience && channel === 'witnessed')
    return actual(
      new RegExp(
        `${name}[\\s，,:：]*(?:实际|确实|亲自|已经)?(?:第[一二三四五六七八九十\\d]+次)?(?:完成学习|掌握|学会|习得|使用|将|用|插入|转动|打开|完成|执行)`,
        'u',
      ),
    );
  if (channel !== 'told' && channel !== 'rumor') return false;
  // The verb must describe a receipt, rather than the actor merely speaking.
  return (
    actual(
      new RegExp(
        `(?:明确|亲口|直接|已经)?(?:告诉|告知|通知|传达给|told|informed)[\\s]*${name}`,
        'iu',
      ),
    ) ||
    actual(
      new RegExp(
        `(?:向|对)[\\s]*${name}[\\s]*(?:明确|亲口|直接)?(?:讲明|说明|说[：:“「『"]|告知|传达)`,
        'iu',
      ),
    ) ||
    actual(new RegExp(`${name}[\\s，,:：]*(?:被告知|received the message)`, 'iu'))
  );
}
function sharesAcquisitionTopic(
  negativeClause: string,
  candidate: KnowledgeCandidate,
  actors: KnowledgeActor[],
): boolean {
  const scrub = (value: string) => {
    for (const alias of actors
      .flatMap((actor) => actor.aliases)
      .sort((a, b) => b.length - a.length))
      value = value.split(alias).join(' ');
    return value.replace(
      /听到|听见|听清|听说|看见|看到|目睹|见证|获知|得知|知道|知晓|意识到|推断|推测|猜出|告诉|告知|通知|没有|并未|尚未|实际上|当时|仍然|从未|未知/gu,
      ' ',
    );
  };
  const negative = scrub(negativeClause),
    content = scrub(candidate.evidence.map((e) => e.quote).join(' ')),
    words = content.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return words.some((word) =>
    [...word].some(
      (_, at) =>
        at + 1 < [...word].length && negative.includes([...word].slice(at, at + 2).join('')),
    ),
  );
}
/** Source-attributed objective evidence, shared by canon validation. A clipped
 * quotation cannot shed its speaker/imagined/conditional attribution. */
export function objectiveEvidenceFragments(
  source: string,
  quote: string,
  eligible: (clause: string) => boolean = () => true,
): string[] {
  const at = source.indexOf(quote),
    end = at + quote.length;
  const clauses = containingClauses(source, quote);
  return clauses.flatMap((clause) => {
    const exposed = clause.objective.slice(
      Math.max(0, at - clause.start),
      Math.min(clause.objective.length, end - clause.start),
    );
    return !exposed.trim() ||
      !eligible(clause.objective) ||
      nonActual.test(clause.objective) ||
      /(?:声称|宣称|谎称|自称|撒谎|说[：:“]|告诉|告知|听说|听到|认为|相信|猜测|推断|推测|传言|计划|打算)/u.test(
        clause.objective,
      )
      ? []
      : [exposed];
  });
}
/** Fail closed for ambiguous/implicit recipients. This is a syntactic/source
 * prerequisite; a semantic judge may veto it, but cannot bypass it. */
export function validateKnowledgeCandidate(
  candidate: KnowledgeCandidate,
  texts: { user: string; assistant: string },
  actors: KnowledgeActor[],
): KnowledgeProof[] {
  const proofs = candidate.knowledge ?? [];
  for (const proof of proofs) {
    const actor = actors.find((actor) => actor.id === proof.actorId);
    if (!actor?.aliases.length) fail('获知者不存在或名字无法消歧');
    if (candidate.observerId && candidate.observerId !== proof.actorId)
      fail('不能向其他人物授权一条定向信念');
    if (candidate.actorId && candidate.actorId !== proof.actorId)
      fail('经历与能力的获知证据必须属于其角色');
    const clauses = containingClauses(texts[proof.source], proof.quote);
    const sourceClauses = narrativeClauses(texts[proof.source]),
      ownExperience = candidate.actorId === proof.actorId;
    const receipt = (clause: string) =>
      positiveAcquisition(clause, actor!, proof.channel, ownExperience) &&
      (!ownExperience ||
        !actors.some(
          (other) => other.id !== proof.actorId && new RegExp(identity(other), 'u').test(clause),
        ) ||
        positiveAcquisition(clause, actor!, proof.channel));
    // Denials in the exact acquisition sentence always veto. Adjacent denials
    // veto the same content, while unrelated unknowns and an explicitly later
    // acquisition cannot become a permanent, global denial for this person.
    if (
      clauses.some((clause) => deniesAcquisition(clause.objective, actor!)) ||
      sourceClauses.some((clause, index) => {
        if (!deniesAcquisition(clause.objective, actor!)) return false;
        return clauses.some((proven) => {
          const provenIndex = sourceClauses.findIndex((c) => c.start === proven.start);
          if (Math.abs(index - provenIndex) !== 1) return false;
          if (
            index < provenIndex &&
            /后来|随后|此后|终于|直到|现在|重新|接着/u.test(proven.objective)
          )
            return false;
          return (
            sharesAcquisitionTopic(clause.objective, candidate, actors) ||
            new RegExp(
              `^${identity(actor!)}(?:仍然|实际上)?(?:不知|不知道|没有听到|没有被告知)[\\s，。]*$`,
              'u',
            ).test(clause.objective)
          );
        });
      })
    )
      fail('原文明确否定或未确认该角色获知');
    if (!clauses.some((clause) => receipt(clause.objective)))
      fail('缺少角色实际获取信息的明确原句');
    for (const clause of clauses) {
      if (/无人知道|无人知晓|无人察觉|没有人知道|导演秘密|旁白秘密|仅导演/u.test(clause.objective))
        fail('导演私密或无人获知的内容不能授权');
      if (
        privateState.test(clause.objective) &&
        actors.some(
          (other) =>
            other.id !== proof.actorId && new RegExp(identity(other), 'u').test(clause.objective),
        )
      )
        fail('获知原句夹带其他人物的内心活动');
    }
  }
  for (const actorId of new Set(proofs.map((proof) => proof.actorId))) {
    const actorProofs = proofs.filter((proof) => proof.actorId === actorId);
    for (const content of candidate.evidence) {
      const source = texts[content.source],
        at = source.indexOf(content.quote);
      if (at < 0 || source.indexOf(content.quote, at + 1) >= 0) fail('内容原句不存在或不唯一');
      const actor = actors.find((actor) => actor.id === actorId)!;
      // Containment alone is insufficient: a proof that hears one sentence does
      // not authorize adjacent omniscient narration, someone else's belief, or
      // a paragraph-wide episode. Every exposed clause needs a receipt for this
      // recipient; the model must narrow the content quote when it does not.
      for (const clause of containingClauses(source, content.quote))
        if (
          !actorProofs.some(
            (proof) =>
              positiveAcquisition(
                clause.objective,
                actor,
                proof.channel,
                candidate.actorId === actorId,
              ) &&
              (candidate.actorId !== actorId ||
                !actors.some(
                  (other) =>
                    other.id !== actorId && new RegExp(identity(other), 'u').test(clause.objective),
                ) ||
                positiveAcquisition(clause.objective, actor, proof.channel)),
          )
        )
          fail('内容证据夹带没有该角色获取依据的叙事片段，请缩小原句');
      if (
        !actorProofs.some((proof) => {
          const p = source.indexOf(proof.quote);
          return (
            proof.source === content.source &&
            p <= at &&
            p + proof.quote.length >= at + content.quote.length
          );
        })
      )
        fail('获知证据未覆盖该角色将读取的每一条内容证据');
    }
  }
  return proofs;
}
