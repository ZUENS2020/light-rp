# 中文记忆回放评测

```sh
npm run eval
# 可选择输出逐题 JSON 报告：
npm run eval -- --output /absolute/path/to/evaluation-report.json
```

评测直接执行真实 `Store` / `MemoryEngine` 和迁移 SQL。`tests/d1.ts` 使用 better-sqlite3 提供 D1 接口，保留真实外键、FTS5、约束、SQL trigger 和事务回滚。每次运行新建内存数据库，不读取用户故事、生产数据库或 R2，也不调用模型。

数据在 `tests/fixtures/evaluation-stories.ts`：8 个手工合成中文故事（雾港、宫廷、空间站、森林、雨城、学院、沙漠、剧院），雾港主线延长到连续 500 回合，另外 7 条主线各 64 回合，共 948 个主线回合；另加支线回合和一个其他租户素材，总计 957 次提交。每故事有 16 个明确预期的 gold 问题，共 128 题。测试是模板覆盖的合成回归基线，不是独立真实用户语料或文学质量基准。

每个回合经过 appendTurn 提交事件、显式授予原文片段知情、再 extract 写入手工标注候选并推进连续 cursor。候选携带真实原文的 Unicode code-point offsets，不能绕过引用校验；角色标签不代替 grant。回放执行作者纠正、有效时间变更、32 回合分叉、遗忘、来源删除、独立经验案例和能力记录。

实测范围：长会话后的早期事实、关系、角色信念与客观事实分离、秘密拥有者与其他角色、同一来源的片段授权、时间前后状态、分支正反召回、遗忘、删除后的旧向量 ID、两次独立成功后的程序经验，以及其他故事/租户候选的数据库后验过滤。每题检查 gold ID 是否进入前 5、禁止 ID 是否进入任何结果、token 上限和每条返回证据是否仍与活动原文精确相符。对针对性的信念/关系/技能查询使用调用者 kinds 过滤，报告不是模型自动分类能力。

报告包含正向问题 recall@5 和 MRR@5、全部正反问题通过率、越界结果数、token/来源违规数、真实执行 p50/p95/max 延迟、降级查询数及逐类别/逐题结果。延迟包含 recall 与原文回读校验，在本机 SQLite 上测得，不能外推 Cloudflare 网络/托管延迟。身份、分支和删除测试会故意注入越界或过期向量候选 ID，但向量排序输入是测试提供的；不代表真实 embedding/Vectorize 服务的语义质量。

本节本地回放的 LLM 抽取 precision/recall、摘要事实保真度、开放问答正确率都明确为 `not-run` / null。它没有调用模型，不填伪造分数；实际模型结果见下文独立评测。开放问答需另有答案 gold 和人工盲评。当前回放不测情节好坏、自然语言推理质量、托管延迟或真实生产长会话成本。

任何题不通过、出现越界、来源不一致或超预算，CLI 返回非零退出码。失败题始终列出，不通过修改 gold 来掩盖行为回归。

另有真实 D1 回归测试 `tests/runtime-boundaries.test.ts` 与 `tests/vector-boundaries.test.ts`，核验取消、迟到流事件、删除后的旧快照、原子观察依赖、重复派发、旧任务重试、R2 写入后的来源校验，以及同一不可变记忆版本跨视角的 embedding 复用和 Vectorize 删除补偿。R2、Workflows 和 Vectorize 的网络行为使用可注入故障的边界替身；数据库部分使用完整迁移、SQLite 事务和真实来源状态。它们验证程序边界，不代表已执行托管服务的故障演练。

`tests/observations.test.ts` 覆盖滚动压缩的旧摘要合并、超过旧上限的 80 条记忆、Unicode 长开篇、迟到抽取、失败续跑、纠正、来源删除、传递授权撤销、并发水位、技能前提与暂停历史，以及 500 条事件和嵌套分支。反思器使用明确的测试替身，只检验系统集成、覆盖、预算和事务边界，不能作为真实模型摘要保真率。超长开篇在 `tests/rebuild.test.ts` 中还通过真实 MemoryWorkflow 的源处理账本，不会卡在原子事实的 20,000 字符上限。真实预览记录另见 [滚动压缩上线记录](rolling-compression-live-report.json)，该记录仅保存进度及验证元数据。

## 真实模型对照

```sh
# 不传 --run 时只展示调用计划，不请求模型
npm run eval:live

# 在已配置真实模型的 Access 服务身份下执行完整 128 题 × 3 方案
LRP_BASE_URL=https://lightrp-preview.zuens2020.work \
API_AUTH_HEADERS_FILE=/absolute/private/access-headers.json \
npm run eval:live -- --run --full --max-model-calls=513 --output /absolute/path/live-evaluation-report.json
```

认证头文件须是当前用户拥有、0600 权限的普通 JSON 文件；不把凭据放在命令行、报告或仓库中。远程评测只允许验证过的服务身份，数据放在独立评测 owner 中，不读取用户故事。默认小规模实跑选择 8 题、至多 33 次模型调用；完整计划为 128 题三组回答和按视角/分支/时间缓存的摘要，预留最多 513 次调用。每个请求保留延迟和实际返回的 usage，账单成本未读取则为 null。

三方案使用同一有效原文及作用域：近期原文仅保留最近 16 条；摘要由真实模型压缩并验证来源；混合方案使用真实 Store 词法、关系和时间召回。注入的旧向量 ID 仅测后验权限过滤，不能算 Vectorize 语义召回质量。答案以归一化的中文 gold 片段严格匹配，报告同时记录未知回答、泄密、纠正、引用有效性及延迟；严格字符串通过率不能当成人工语义盲评。候选抽取仍来自人工 gold，因此抽取 precision/recall 继续为空。

早期失败记录保存在 [10 月 5 日运行](live-evaluation-failed-2026-10-05.json) 和 [10 月 7 日运行](live-evaluation-failed-2026-10-07.json)，8 题试跑保存在 [小规模对照](live-evaluation-pilot-report.json)。[完整 128 题报告](live-evaluation-report.json) status 为 complete：433 次模型调用，包括 384 份回答、48 份摘要和一次连接探针。三组各尝试 128 题，无 HTTP 失败；严格通过分别为近期原文 58、摘要 100、混合记忆 109。计分将请求失败纳入分母，不能只报告成功请求的正确率。

混合方案 80 个正向召回问题均命中 gold，88 个预设事实片段均精确匹配，但 unknown 标志及严格答案规则仍造成 19 道失败。三个方案各 24 道真正角色／片段隔离问题均未命中泄露片段；摘要另有 2/80 个历史旧值禁止片段命中，该指标不称角色泄密。引用 ID 的活动性及授权有效率与语义证据支持分开，后者未人工评估，保持 null。追加汇总修正保留原始结果、摘要、journal 和固定 gold 哈希，未重写模型答案或 gold。

另有 [Workers AI 云端 smoke 记录](cloud-smoke-workers-ai-report.json)：实际叙事提交、后台抽取/观察、Vectorize 索引及再次召回均完成。它验证托管链运行，不提供质量门槛或故障恢复成功率。

## 真实抽取与向量质量

```sh
# 先检查零网络调用计划
npm run eval:quality
# 同一认证环境中，仅运行真实抽取，最多 60 次调用尝试
npm run eval:quality -- --run --extraction-only --cases=20 --max-model-calls=60
# 另运行实际 embedding 与 Vectorize；最多 80 次 embedding 调用
npm run eval:quality -- --run --vector-only --max-embedding-calls=80 --output docs/vector-quality-report.json
```

抽取语料为 `tests/fixtures/extraction-quality.ts` 中 20 个固定中文案例，覆盖谎言、明确告知、内心、猜测、计划、未知结果、能力学习、反例、同名实体、作者设定及证据伪造。脚本运行产品中的实际 `analyze`，保留模型回应、修复尝试、精确来源检查和固定规则评分。未判定的额外预测不自动当成正确；报告分别给出 precision 下界、上界和已判定预测的条件 precision。完整 precision 未判定时为 null，不能用条件 precision 宣称达到 ≥95%。

`modelCalls` 表示进入调用函数的尝试数，不保证提供方实际执行或收费。`returnedModelResponses` 与 usage 数另列；全无模型输出的传输失败不计算语义 precision/recall。失败响应、截断及修复记录保留，不通过修改 gold 来掩盖问题。[原始抽取基线](model-quality-baseline-report.json) 与 [复杂 schema 传输失败](model-quality-schema-failure-report.json) 均独立存档。

Qwen 的简单摘要／问答 schema 已有成功记录；Qwen 与 Llama70B 的复杂抽取 schema 均曾在提供方返回正文前失败，因此只对这两个明确模型的复杂抽取显式选择提示约束协议，省略提供方 `response_format`，继续服务端 JSON、来源、归属和规则校验，不把截断片段作为有效结果。其他请求保留原生 schema。[Llama 原生 schema 失败](extraction-llama-probe-report.json) 为 1 次调用尝试、0 正文、0 usage，不计算模型语义质量。

[Qwen 20 例提示协议报告](model-quality-qwen-prompt-report.json) 保留旧版本完整比较：29 次调用均返回正文和 usage，17 例接受、3 例来源／结构校验失败；固定原子事实命中 2/13（15.38%）。事实预测 TP 2、FP 0、未判定 7，完整 precision 为 null，不能用已判定预测的 100% 宣称达到 ≥95%。独立安全审计包括 episode，发现 q04 同一案例的 3 条已接受候选把未听见告知的丙列为知情者；本评测 API 不提交剧情记忆，这些记录属于授权风险候选。原始候选及引用逐条保存，不能因 episode 未计原子 precision 而省略风险。

[最新抽取报告](model-quality-report.json) 冻结为 `partial`。部署版本 `cce6fae6-fff0-40b9-85e4-c714a13870e3` 已应用 `source-proof-v1` 与 `0004_knowledge_channels`，`knownBy` 仅作为 hint，实际知情授权须有 `knowledge` 原文 proof。统一叙事仍为 Qwen，评测请求固定辅助模型 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`、`decisionModel=''`，不修改 owner 设置；Clef 独立评测不混入此次抽取质量。

[Llama 提示协议探针](extraction-llama-prompt-probe-report.json) 在 18:10 CST 完成 q01：1 次调用、1 份正文、1 项 usage，事实 TP 1、FP 0、未判定 1，完整 precision 与 95% 门槛均为 null。实际 usage 为输入 1,486、输出 150、总计 1,636 tokens，提供方返回 70.348953 neurons；没有读取美元账单。抽取处理耗时 5.199 秒。q01 的已尝试事实命中 1/1，仅表示单例结果；其余 19 例从未启动，系统 turn abort 后恢复时临时凭证已于 18:26 CST 过期，停止追加调用。完整 20 例质量、新版 q04 授权修复效果及其他知情案例均尚未实测，不得把单例零冲突当作全部安全验收通过。

[0 次调用的连接失败](extraction-llama-prompt-network-failure-report.json) 独立保留，失败发生在模型调用前。报告区分可审查正文的条件语义统计、全部已尝试案例的端到端召回，以及尚未尝试的固定案例；原始输出、gold 和 usage 不因补充部署信息或汇总而改变。

[真实向量报告](vector-quality-report.json) 使用 `@cf/baai/bge-m3` 的 1024 维 embedding 和实际 Vectorize：20 个正向问题的向量 Recall@10 与混合 Recall@10 均为 100%；3 个秘密／删除／跨分支反向用例全部阻止非法展开，禁止结果为 0。删除用例先确认旧向量实际可读，再删除来源并观察旧索引命中被 D1 拒绝。语料只有 20 个固定事实、8 个干扰条目和 2 个权限条目；该结果满足这组小规模用例的 ≥90% 门槛，不能外推大型语料质量。
