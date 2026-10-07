# Hermes RP 叙事前置层

2026-10-07 通过已配置的 `ssh nec` 连接 NEC，定位到 `/home/zuens2020/.hermes/characters/character_engine.py` 的 `build_soul_md`，第 224 行开始的“破限层（多层防御，v3.1 强化版）”。当时文件 SHA-256 为 `9a907bd6cddc15c34c27452882e212c0d9ac32e6a464f9271da3cb76137addf0`。使用 AST 读取常量及角色名占位符，没有执行远程角色引擎或修改 NEC 配置。当前 `SOUL.md` 只有该段的简短任务定义；本次采用引擎中完整的任务定义、Override Request 和身份覆盖段。

模板保存在 `src/shared/narrative-preamble.ts`。原来绑定单个角色的身份改为统一叙事者及 `{{cast}}`，不带入无声铃鹿卡片、历史聊天、工具能力或状态栏。角色名称以 JSON 编码替换，避免名字中的换行、替换符或嵌套占位符改变模板结构；支持自定义 `{{user}}` 玩家名。

设置页“叙事前置层”可直接编辑，提供“载入 Hermes 头部”和“清空前置层”，保存后用于新任务。提示顺序为：前置层 → 叙事指引 → 应用叙事约束／场景 → 角色卡、世界书、记忆和正文。前置层计入必要上下文预算，超过预算明确失败；不会悄悄截断或丢弃。

它仅进入叙事上下文，不进入抽取器或 Clef 的 `boundHardRules`，也不创建世界事实、角色授权、技能或应用权限。原模板中的“协议禁用”是提示文本，不是模型服务开关，实际响应取决于所配置的提供方。后续的知情、来源和事务验证照常执行。

新设置默认提供 Hermes 模板。`0005_hermes_narrative_preamble.sql` 只为已有、尚无此字段的人类所有者补入模板，保留叙事指引和模型选择；显式空值、自定义值、服务评测设置和已冻结任务配置不改写。旧任务缺少该字段时按空前置层解析，避免历史任务在恢复时改变配置。

回归覆盖模板顺序、多角色与单角色视图、规则分离、明确清空、预算、旧任务以及迁移重复执行。浏览器用例通过实际 Worker 验证编辑、保存、清空、重新加载和上下文组装。

2026-10-07 验证：`npm run check` 通过 28 个文件、303 项测试、TypeScript 与生产构建；确定性中文回放 128/128 题通过，8 个故事及 957 次提交包含一条 500 回合主线。浏览器验收 9/9 通过，格式检查通过。本次未另做真实模型的 RP 效果评测。

独立 V3 预览已部署版本 `4fa6182a-d606-4e52-8f1f-80b7b4fe7183`，地址为 https://lightrp-preview.zuens2020.work。Wrangler 的 D1 迁移请求遇到授权错误，改用已授权 Cloudflare 连接器执行同一 SQL 并登记 `0005`，随后部署成功。迁移时没有持久化的人类设置行，因此使用包含模板的新默认设置；两条服务设置未补入前置层。旧生产资源和 NEC 服务配置均未改动。

## Hermes 叙事设计适配与直连（2026-10-07）

进一步阅读 NEC 上同一 `character_engine.py` 的核心规则、身体／姿势一致性、首条消息锚定、人物字段、情绪惯性、关系递进、对话个性与节奏，以及 `preload_worldbooks` 和 `worldbook_engine.py`。远程代码与技能文件只作设计参考，没有执行 `load`、修改 SOUL.md 或导入 NEC 的私人角色和会话。

新叙事指引位于 `src/shared/hermes-rp.ts`，作为新配置的 `systemPrompt` 默认值。设置页可“载入 Hermes 叙事指引”，编辑后保存；已有自定义、明确空值和冻结任务保留原指引。原 ANLAN 前置模板保持独立，正文指引覆盖防抢玩家台词、作者模式接续开头、多角色个性、动作／物品／衣物／情绪连续性和当前关系阶段，默认不附状态栏。具体篇幅、格式与视角听从作者当前要求，不强制每句动作或固定篇幅配比。

每次按分支绑定的角色版本读取原始资料中的 `age`、`gender/sex`、`behavior`、`speech`、`likes/dislikes`、`backstory`（含对应首字母大写字段），以标明角色的局部资料注入。明确空字段优先，不从姓名、标签或性别关键词推断身体。未知扩展及原始 JSON 保留。聚焦角色的 `first_mes` 现在跨回合提供预算内文风锚定，明确标注不重演、不视为新事件；同样受角色视图范围过滤。超过预算的可选范本可以省略，必要规则仍严格计费并超限报错。

世界书继续使用 LightRP 的已绑定版本、关键词、概率、位置、递归与预算激活流程。Hermes 的全局 SOUL 身份切换、文件工具调用、截断式世界书索引及 Telegram `/fix`、`/status` 命令没有移植；LightRP 已有故事内纠正和独立人物／场景面板。叙事指引不能创建角色知情授权或绕过提交校验。

### Command Code 连接

按用户最新选择，预览所有者已保存 `mode=openai`、`provider=commandcode`、`baseUrl=https://api.commandcode.ai/provider/v1`、`model=deepseek/deepseek-v4.1-flash`。来源是 NEC Hermes 当前活动模型配置；辅助模型为空，复用同一模型，Clef 判断默认关闭。服务端 `MODEL_API_KEY` 使用 Hermes 的 `COMMANDCODE_API_KEY`，只存 Worker secret，不写入数据库、前端或仓库。API 格式依据 [Command Code 官方 Provider 文档](https://commandcode.ai/docs/provider)。这仅改变预览所有者的模型配置，其他已有账号及冻结任务保留自己的选择。

叙事与结构化抽取均由 Worker 直接请求 Command Code，未经过 AI Gateway。bge-m3 embedding 仍使用 Workers AI binding 和 Vectorize。此前临时配置的 Command Code Gateway provider、BYOK 和 Secrets Store 条目已移除；原 `sillytavern` Gateway 和其他 provider 保持现状。

实际 workerd 探针发现 `redirect: error` 在此运行时会抛出 TypeError（与当前 Request 文档的列举不同）。传输改为 `manual`，非 2xx 响应由现有处理器拒绝，避免将密钥转发给重定向目标。新增直连与 307 拒绝回归。

预览版本 `227593b0-f21c-4273-89d1-0e44759bbb50` 的实际 Worker 连接测试返回 HTTP 200、`连接成功。`，74 个总 token。`npm run check` 通过 29 个文件／307 项测试、类型检查、构建与 128/128 确定性问题；本次新增提示控件的真实本地 Worker 浏览器用例通过（已安装 Chrome）。

首次真实叙事生成成功，但三次抽取修复后仍因缺少明确的角色获取原句而拒绝提交，草稿保留，见 `commandcode-direct-first-attempt-report.json`。这是保守知情校验与模型抽取配合的实际失败，不能以连接成功推断全面模型质量达标。

第二次尝试因输出预算达到 4096 token 上限而失败，见 `commandcode-direct-second-attempt-report.json`。第三次使用明确指名的获知句及 8192 输出预算，实际流式正文（3 个 delta）、结构化抽取、原子提交、两种观察／事实投影、索引和再次召回完成；同请求幂等与取消后无迟到提交通过，详见 `commandcode-direct-acceptance-report.json`。因此预览所有者的输出预算保存为 8192。上下文窗口仍为 32768，并按既有算法扣除输出预留。

本轮没有关闭提供方思考：额外探针中 `thinking: {type: disabled}` 被接收但仍产生 reasoning token，`reasoning_effort: none` 返回 400，没有把未经验证的控制参数加入生产。第三次通过的合成案例不能抵消前两次失败，也不代表角色知情的复杂表达或完整抽取精确率达标。

最终预览版本为 `d0a43a84-1e52-4d55-b901-c8615289968d`（仅再更新直连设置标识；Worker 叙事／抽取逻辑与完整链验收版本一致）。该版本连接复测 HTTP 200、97 个总 token，新增 Hermes 设置浏览器用例再次通过。用于本轮验收的临时 Access 策略、服务 token 和本地认证头文件已移除，正式所有者策略保留。
