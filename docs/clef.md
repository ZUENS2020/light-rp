# Clef 记忆证据判断

2026-10-07 核验的 Cloudflare 判断模型是 [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) 和 [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/)。它们实现 System One 的 typed decision 接口：给定 state 与问题，返回各选项概率；本项目使用 `noul` 判断，不让它承担叙事或抽取正文。官方说明见 [发布文章](https://blog.cloudflare.com/clef-decision-models/)。

设置页新增“记忆判断模型”和独立连接测试。默认关闭，可选择 Clef 或 Clef-flash；两者均通过原生 Workers AI binding 调用，与叙事／辅助模型配置分开。建议先选 Clef。改变设置只影响新任务，已有任务使用冻结配置。

流程为：抽取 JSON → 角色 ID、逐字来源、权威及获取证明的确定性校验 → 可选 Clef 判断 → 原子剧情提交。判断模型只增加拒绝条件，不能创建事实、知情授权、能力、独立成功次数或提交权限。来源删除、分叉、作者纠正、版本冲突和取消继续受 D1 提交 guard 控制。

每个请求只判断一个当前回合的候选，包含完整当前输入、正文、绑定规则和候选引文。事实区分客观叙述、陈述、信念、情节和关系；经历区分计划、实际尝试、未知结果和成功；能力要求学习证据；获取证明另问角色是否确实获得该片段。不同故事不合并到一次请求。最多四个并行请求、一次抽取最多 64 个候选；完整判断输入超过 24,000 估算 token、48,000 UTF-8 字节或 200,000 字符时明确报预算错误。字节限额为模型模板预留空间，估算 token 不是提供方 tokenizer 的实测计数。

开发阈值为 p≥0.9 支持、p≤0.1 拒绝，中间保留不确定。阈值尚未经过大语料校准，概率不能解释为确定正确。拒绝、不确定或服务不可用时，生成正文保留为草稿，剧情不推进；不悄悄关闭检查后提交。成功及失败的候选路径、概率、阈值版本、usage 和耗时记录在任务审计。Gateway 正文日志与缓存关闭。

## 真实 API 实测

固定 gold 在 `tests/fixtures/decision-quality.ts`，20 个中文案例覆盖谎言、误信、未听见、内心、计划、自称成功、实际成功、学习、反例、随机结果、纠正、时间、同名实体、重复经历和引文指令。gold 不放进模型请求。

| 一场景一请求，20 例     |          Clef |   Clef-flash |
| ----------------------- | ------------: | -----------: |
| p=0.5 二分正确          |         20/20 |        20/20 |
| 按 0.9/0.1 阈值明确判断 |         20/20 |        19/20 |
| 不确定                  |             0 |            1 |
| 高置信度误接受／误拒绝  |           0/0 |          0/0 |
| API 请求 p50 / p95      | 508 / 1098 ms | 267 / 969 ms |
| 输入／输出 token 合计   |      4165 / 0 |     4165 / 0 |

原始回答与 usage 在 [逐场景报告](clef-single-scenarios-report.json)。另将 20 个独立故事放入同一 state 的实验中，Clef 二分正确 20/20，但两题不确定；Flash 仅 14/20，其中作者纠正题被高置信度判错，见 [混批报告](clef-batched-scenarios-report.json)。因此产品采用逐候选请求，并优先 Clef。这组结果仅是小规模合成回归，不是整体质量或概率校准证明。

通过部署后的 Workers AI binding 与 Gateway 重跑同一固定语料，40 次调用均有合法回应。Clef 20/20 明确且正确，Flash 18/20 明确且正确、2/20 不确定；两者按 p=0.5 二分均为 20/20，无高置信度误接受或误拒绝。调用 p50/p95 分别为 Clef 523/1269 ms、Flash 330/488 ms；各使用 4165 个输入 token、0 个输出 token。完整原始结果在 [Worker 实测报告](clef-worker-evaluation-report.json)，灰区不得计为产品明确通过。

[完整云端链验收](clef-cloud-acceptance-report.json) 还执行了一个实际合成剧情：抽取后的候选由 Clef 判断为支持（p=0.9761，731 个输入 token），再完成原子剧情提交、后台事实／观察及索引、再次召回和下一回合取消。幂等重复请求只产生一个任务，取消后剧情序号未推进。该单例验证实际接线，不能证明全部自动抽取准确率。

官方当日输入价格为 Clef $0.24/百万 token、Flash $0.09/百万 token。上述各 20 次请求按标价推算约 $0.0010 / $0.000375，未读取账单，实际费用保持 null；不包含 Gateway、存储和其他模型调用。长剧情与较多候选应按实际 usage 评估费用。

## 复现 Worker binding

```sh
# 默认零网络调用，展示 20×2 的固定计划
npm run eval:decisions
# 服务身份、仅合成资料；认证文件须 0600，不能进入仓库
LRP_BASE_URL=https://lightrp-preview.zuens2020.work \
API_AUTH_HEADERS_FILE=/absolute/private/access-headers.json \
npm run eval:decisions -- --run --max-model-calls=40
```

`/api/v3/evaluate/decisions` 沿用本地／认证服务身份限制，只有固定合成场景，无任意用户故事读取接口。评测失败仍写入结果分母和原始报告。设置页连接测试使用固定谎言例，不读取现有故事。
