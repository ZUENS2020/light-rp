/** Fixed, hand-authored synthetic gold. Never generated from, or edited to fit, model outputs. */
export type QualityCategory = 'fact' | 'experience' | 'capability';
export interface QualityGold {
  id: string;
  category: QualityCategory;
  kinds?: string[];
  subjects?: string[];
  valueGroups?: string[][];
  names?: string[];
  outcomes?: string[];
  requiredKnownBy?: string[];
  forbiddenKnownBy?: string[];
  observerId?: string;
  validFrom?: number;
  validTo?: number;
  level?: string;
}
export interface QualityForbidden extends QualityGold {
  reason: string;
}
export interface ExtractionQualityCase {
  id: string;
  category: string;
  mode: 'roleplay' | 'author';
  user: string;
  assistant: string;
  expected: QualityGold[];
  forbidden: QualityForbidden[];
  names?: [string, string, string];
  previous?: string;
  forbidCalendarDate?: boolean;
}
const fact = (
  id: string,
  subject: string,
  value: string,
  extra: Partial<QualityGold> = {},
): QualityGold => ({
  id,
  category: 'fact',
  kinds: ['canon'],
  subjects: [subject],
  valueGroups: [[value]],
  ...extra,
});
const belief = (id: string, value: string, observerId = 'actor-b'): QualityGold => ({
  id,
  category: 'fact',
  kinds: ['belief'],
  subjects: [observerId, '钥匙'],
  valueGroups: [[value]],
  observerId,
  requiredKnownBy: [observerId],
  forbiddenKnownBy: ['actor-a', 'actor-b', 'actor-c'].filter((id) => id !== observerId),
});
const experience = (id: string, outcome: string): QualityGold => ({
  id,
  category: 'experience',
  names: ['开锁', '解锁'],
  outcomes: [outcome],
  subjects: ['actor-a'],
});
const noCapability: QualityForbidden = {
  id: 'no-implicit-capability',
  category: 'capability',
  reason: '没有明确学习事件，不能由尝试、读书或成功推断能力',
};
const noSuccess: QualityForbidden = {
  id: 'no-unproven-success',
  category: 'experience',
  outcomes: ['success'],
  reason: '原文没有已执行且已确认的成功结果',
};
export const extractionQualityCases: ExtractionQualityCase[] = [
  {
    id: 'q01-truth',
    category: '世界真相',
    mode: 'roleplay',
    user: '继续查看仓库。',
    assistant: '钥匙静静放在仓库的木箱上。没有角色看到这一幕。',
    expected: [
      fact('key-location', '钥匙', '仓库', { forbiddenKnownBy: ['actor-a', 'actor-b', 'actor-c'] }),
    ],
    forbidden: [],
  },
  {
    id: 'q02-lie',
    category: '谎言与误信',
    mode: 'roleplay',
    user: '让乙回应甲。',
    assistant:
      '钥匙实际仍在工坊。甲对乙撒谎说：“钥匙在仓库。”乙听清了这句话，并相信钥匙在仓库。丙没有听到。',
    expected: [fact('truth', '钥匙', '工坊'), belief('belief', '仓库')],
    forbidden: [{ ...fact('lie-as-truth', '钥匙', '仓库'), reason: '甲的谎言不能覆盖世界真相' }],
  },
  {
    id: 'q03-inner',
    category: '内心与秘密',
    mode: 'roleplay',
    user: '甲若无其事地继续走。',
    assistant: '甲心里决定子夜去东桥见线人。这只是甲的内心决定，乙和丙都不知道。',
    expected: [],
    forbidden: [
      {
        id: 'secret-to-others',
        category: 'fact',
        requiredKnownBy: ['actor-b'],
        reason: '乙没有获知甲的内心活动',
      },
      {
        id: 'secret-to-third',
        category: 'fact',
        requiredKnownBy: ['actor-c'],
        reason: '丙没有获知甲的内心活动',
      },
    ],
  },
  {
    id: 'q04-told',
    category: '明确告知',
    mode: 'roleplay',
    user: '乙询问钥匙。',
    assistant:
      '钥匙在仓库。甲走到乙身边，明确告诉乙钥匙就在仓库；乙听清并记住了这件事。丙在远处没有听到。',
    expected: [
      fact('told-location', '钥匙', '仓库', {
        requiredKnownBy: ['actor-b'],
        forbiddenKnownBy: ['actor-c'],
      }),
    ],
    forbidden: [],
  },
  {
    id: 'q05-guess',
    category: '猜测',
    mode: 'roleplay',
    user: '甲查看天空。',
    assistant: '甲猜测明天会下雨，但没有证据；未来天气还不知道。乙没有听到甲的猜测。',
    expected: [],
    forbidden: [
      {
        ...fact('guess-as-canon', '天气', '下雨'),
        subjects: undefined,
        reason: '未知天气的猜测不能成为已证实世界事实',
      },
    ],
  },
  {
    id: 'q06-plan',
    category: '未执行计划',
    mode: 'roleplay',
    user: '甲打算开锁。',
    assistant: '甲计划明天用铜钥匙开锁，现在还没有开始，也没有结果。',
    expected: [],
    forbidden: [noSuccess, noCapability],
  },
  {
    id: 'q07-success',
    category: '实际成功不授予能力',
    mode: 'roleplay',
    user: '甲尝试开锁。',
    assistant: '甲把铜钥匙插入门锁，转动一圈，门锁确实打开了。这次开锁成功，但没有学习新能力。',
    expected: [experience('actual-success', 'success')],
    forbidden: [noCapability],
  },
  {
    id: 'q08-boast',
    category: '自称成功与未知结果',
    mode: 'roleplay',
    user: '甲说：“我开锁成功了。”',
    assistant: '甲只是自称成功。门锁被帘子挡住，没有人确认它是否打开，实际结果未知。',
    expected: [],
    forbidden: [noSuccess, noCapability],
  },
  {
    id: 'q09-no-tool',
    category: '前提不符',
    mode: 'roleplay',
    user: '甲尝试打开门。',
    assistant:
      '甲伸手准备开锁，却发现铜钥匙不在身上。开锁失败，因为缺少钥匙；这不证明开锁方法失效。',
    expected: [experience('failure', 'failure')],
    forbidden: [noCapability],
  },
  {
    id: 'q10-learning',
    category: '明确学习能力',
    mode: 'roleplay',
    user: '师傅继续教学。',
    assistant: '师傅实际教甲练习打结。甲反复练习后学会了打结，师傅明确认定甲获得初级打结能力。',
    expected: [
      {
        id: 'learned-knot',
        category: 'capability',
        subjects: ['actor-a'],
        names: ['打结'],
        level: '初级',
      },
    ],
    forbidden: [],
  },
  {
    id: 'q11-reading',
    category: '读书不等于掌握',
    mode: 'roleplay',
    user: '甲阅读一本书。',
    assistant: '甲读到了开锁步骤，但没有练习，也没有人确认他掌握开锁能力。',
    expected: [],
    forbidden: [noSuccess, noCapability],
  },
  {
    id: 'q12-correction',
    category: '作者纠正',
    mode: 'author',
    user: '作者更正：钥匙是蓝色，之前记录的红色是错误的。',
    assistant: '作者纠正已经生效：钥匙实际是蓝色，红色记录被明确撤销。',
    previous: '旧记忆错误地把钥匙记为红色。',
    expected: [fact('correct-blue', '钥匙', '蓝色')],
    forbidden: [
      { ...fact('revive-red', '钥匙', '红色'), reason: '明确撤销的红色不能继续作为当前事实' },
    ],
  },
  {
    id: 'q13-time',
    category: '历史与当前',
    mode: 'roleplay',
    user: '核对位置变化。',
    assistant:
      '在剧情时刻10，钥匙在工坊；该状态在时刻15结束。自剧情时刻15起，钥匙移到了仓库，现在仍在仓库。',
    expected: [
      fact('old-location', '钥匙', '工坊', { validFrom: 10, validTo: 15 }),
      fact('current-location', '钥匙', '仓库', { validFrom: 15 }),
    ],
    forbidden: [],
  },
  {
    id: 'q14-homonyms',
    category: '同名实体',
    mode: 'roleplay',
    names: ['小明', '小明', '丙'],
    user: '继续记录两人的行踪。',
    assistant: '编号actor-a的小明留在工坊；编号actor-b的小明独自去了仓库。二人是不同的人。',
    expected: [fact('first-name', 'actor-a', '工坊'), fact('second-name', 'actor-b', '仓库')],
    forbidden: [
      { ...fact('swapped-first', 'actor-a', '仓库'), reason: '同名的 actor-a 没有去仓库' },
      { ...fact('swapped-second', 'actor-b', '工坊'), reason: '同名的 actor-b 没有留在工坊' },
    ],
  },
  {
    id: 'q15-relations',
    category: '多值关系',
    mode: 'roleplay',
    user: '说明彼此关系。',
    assistant: '甲与乙是朋友，甲与丙也是朋友。后一段友情没有结束前一段友情。',
    expected: [
      {
        id: 'friend-b',
        category: 'fact',
        kinds: ['relation'],
        subjects: ['actor-a'],
        valueGroups: [['actor-b', '乙']],
      },
      {
        id: 'friend-c',
        category: 'fact',
        kinds: ['relation'],
        subjects: ['actor-a'],
        valueGroups: [['actor-c', '丙']],
      },
    ],
    forbidden: [],
  },
  {
    id: 'q16-calendar',
    category: '未知日期',
    mode: 'roleplay',
    user: '过了一会儿，继续。',
    assistant: '钥匙现在到了港站。没有人记录年月日，剧情只知道“过了一会儿”。',
    expected: [fact('port', '钥匙', '港站')],
    forbidden: [],
    forbidCalendarDate: true,
  },
  {
    id: 'q17-selective',
    category: '知情片段',
    mode: 'roleplay',
    user: '乙停在门外。',
    assistant:
      '钥匙在仓库，乙通过窗户亲眼看到钥匙在仓库。甲心里另有子夜去东桥的秘密计划，乙不知道这个内心计划，丙也不知道。',
    expected: [fact('seen-location', '钥匙', '仓库', { requiredKnownBy: ['actor-b'] })],
    forbidden: [
      {
        id: 'inner-leak',
        category: 'fact',
        valueGroups: [['子夜'], ['东桥']],
        requiredKnownBy: ['actor-b'],
        reason: '看到钥匙不等于获知甲的内心计划',
      },
    ],
  },
  {
    id: 'q18-stochastic',
    category: '随机结果',
    mode: 'roleplay',
    user: '甲用有随机性的魔法尝试开锁。',
    assistant:
      '甲按原步骤施放随机开锁魔法，步骤正确，但这一次随机失败，门锁没有打开。这一次失败不是确定的方法反例。',
    expected: [experience('random-failure', 'failure')],
    forbidden: [noSuccess, noCapability],
  },
  {
    id: 'q19-partial',
    category: '部分完成',
    mode: 'roleplay',
    user: '甲继续开锁。',
    assistant: '甲转动铜钥匙，锁舌只退了一半，门仍没有打开。开锁只完成了一部分。',
    expected: [experience('partial', 'partial')],
    forbidden: [noSuccess, noCapability],
  },
  {
    id: 'q20-confirmed',
    category: '明确确认成功',
    mode: 'author',
    user: '作者确认甲这一回合的开锁确实成功。',
    assistant:
      '甲本回合已插入铜钥匙并转动，门锁已经打开；作者明确确认这次开锁成功。没有新增学习事件。',
    expected: [experience('confirmed', 'success')],
    forbidden: [noCapability],
  },
];
export interface VectorQualityFact {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  text: string;
  query: string;
}
const vectorRows = [
  [
    'permit',
    '星港通行证',
    'validity',
    '七天',
    '星港通行证的有效期是七天。',
    '星港的入城证能使用多久？',
  ],
  [
    'lighthouse',
    '北岸灯塔',
    'signal',
    '三次短闪',
    '北岸灯塔遇浓雾时发出三次短闪。',
    '大雾中北边的灯塔怎样示警？',
  ],
  [
    'archive',
    '档案馆',
    'opening',
    '午后两点',
    '档案馆每天午后两点才开门。',
    '什么时候可以进入档案馆？',
  ],
  [
    'ferry',
    '东河渡船',
    'fare',
    '两枚银币',
    '东河渡船单程收费两枚银币。',
    '渡过东河需要付多少船钱？',
  ],
  [
    'medicine',
    '解毒药',
    'storage',
    '冷藏',
    '解毒药必须冷藏才能保持药效。',
    '怎样保存抗毒药不会失效？',
  ],
  ['gate', '南门', 'closing', '日落', '南门在日落时关闭。', '太阳落山后南侧城门还开放吗？'],
  ['compass', '罗盘', 'holder', '乙', '罗盘现在由乙保管。', '导航用的指南盘在谁手里？'],
  ['key', '蓝钥匙', 'location', '仓库木箱', '蓝钥匙放在仓库的木箱里。', '开门的蓝色钥匙藏在哪里？'],
  ['teacher', '打结师傅', 'name', '沈墨', '教打结的师傅名叫沈墨。', '那位教授系绳结的老师叫什么？'],
  ['inn', '松影旅店', 'breakfast', '热粥', '松影旅店早餐供应热粥。', '住松影旅店早上能吃到什么？'],
  ['map', '航海图', 'revision', '第三版', '航海图目前采用第三版。', '这份海上路线图用的是哪一版？'],
  ['rope', '救援绳', 'length', '二十米', '救援绳的长度是二十米。', '救人用的绳索有多长？'],
  ['garden', '温室', 'water', '周一', '温室植物每周一浇水。', '哪天给玻璃花房里的植物补水？'],
  ['bell', '警钟', 'meaning', '火灾', '警钟连续鸣响意味着火灾。', '警报大钟一直响代表什么危险？'],
  ['repair', '船匠', 'fee', '五枚金币', '船匠修补船底收取五枚金币。', '请工匠补好船底要多少钱？'],
  [
    'moon',
    '月亮节',
    'date',
    '第八夜',
    '月亮节在每月第八夜举行。',
    '月庆活动安排在一个月里的哪晚？',
  ],
  ['bridge', '旧桥', 'limit', '三人', '旧桥最多允许三人同时通过。', '破旧桥梁能同时站多少个人？'],
  ['seal', '信封', 'seal', '白蜡', '正式信封使用白蜡封口。', '官署寄出的信要用什么封住？'],
  ['bird', '信鸽', 'food', '谷粒', '信鸽只喂谷粒，不喂咸食。', '负责送信的鸽子吃什么？'],
  [
    'tunnel',
    '密道',
    'entrance',
    '钟楼地下',
    '密道入口位于钟楼地下。',
    '秘密通路从哪个建筑的下面进入？',
  ],
];
export const vectorQualityFacts: VectorQualityFact[] = vectorRows.map(
  ([id, subject, predicate, value, text, query]) => ({
    id: id!,
    subject: subject!,
    predicate: predicate!,
    value: value!,
    text: text!,
    query: query!,
  }),
);
