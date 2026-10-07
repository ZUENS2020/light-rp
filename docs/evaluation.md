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

LLM 抽取 precision/recall、摘要事实保真度、开放问答正确率都明确为 `not-run` / null。没有调用模型，不填伪造分数。后续配置模型后，应在同一段原始剧情上运行实际抽取器，与独立人工 gold facts/quotes/grants 比对，记录模型版本、提示版本、成本和取消重试策略；开放问答需另有答案 gold 和人工盲评。当前回放不测情节好坏、自然语言推理质量、托管延迟或真实生产长会话成本。

任何题不通过、出现越界、来源不一致或超预算，CLI 返回非零退出码。失败题始终列出，不通过修改 gold 来掩盖行为回归。

另有真实 D1 回归测试 `tests/runtime-boundaries.test.ts` 与 `tests/vector-boundaries.test.ts`，核验取消、迟到流事件、删除后的旧快照、原子观察依赖、重复派发、旧任务重试、R2 写入后的来源校验，以及同一不可变记忆版本跨视角的 embedding 复用和 Vectorize 删除补偿。R2、Workflows 和 Vectorize 的网络行为使用可注入故障的边界替身；数据库部分使用完整迁移、SQLite 事务和真实来源状态。它们验证程序边界，不代表已执行托管服务的故障演练。

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

现有 [真实模型报告](live-evaluation-report.json) 的状态为 failed：2026-10-05 已创建 8 个故事、520 次提交和 128 题，连接探测成功，只有 2 道近期原文回答完成，摘要接口返回 422 后停止；摘要和混合方案没有完成题目。失败记录保留，不能据此宣布三方案评测通过。后续修复与重跑应检查完整报告 status、各策略题数和请求失败数。

另有 [Workers AI 云端 smoke 记录](cloud-smoke-workers-ai-report.json)：实际叙事提交、后台抽取/观察、Vectorize 索引及再次召回均完成。它验证托管链运行，不提供质量门槛或故障恢复成功率。
