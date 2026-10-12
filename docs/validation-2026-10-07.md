# 2026-10-07 预览验收

预览版本 `cce6fae6-fff0-40b9-85e4-c714a13870e3` 已部署到 [独立 V3 预览](https://lightrp-preview.zuens2020.work)，使用独立 D1、R2、Vectorize、Durable Object 和 Workflows。正式域名切换仍为单独发布步骤。

本次源码检查 `npm run check` 通过：27 个测试文件、297 项测试，绑定类型及 TypeScript、生产构建均通过。中文确定性回放 8 个故事、957 次提交、128/128 题通过，包含一条连续 500 回合主线；越权、失效来源引用及 token 超预算均为 0。这些数据验证数据库与生命周期边界，不能当作 LLM 抽取质量。

浏览器验收 8/8 通过，使用实际本地 Wrangler Worker、D1、R2、DO、Workflows 及已安装 Chrome。执行命令为 `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`；当前机器下载 Playwright 管理的 Chromium 时遇到 CDN TLS 连接中断，未通过关闭 TLS 校验处理。CI 使用自身安装的 Chromium。

远程迁移 `0004_knowledge_channels.sql` 完成。迁移前后 `knowledge_grants` 的行数、最大 rowid、rowid 总和均保持 `2094 / 2094 / 2193465`；稀疏 rowid 和分叉授权上限另有 SQLite 回归验证。没有向旧 D1 应用新迁移。

[Clef Worker 评测](clef-worker-evaluation-report.json) 完成 40 次实际 binding + Gateway 调用：每模型 20 个固定合成中文案例，Clef 20 个明确且正确，Flash 18 个明确且正确、2 个不确定；二分正确率均为 20/20，无高置信度误接受或误拒绝。阈值尚未大样本校准。

[实际 Clef 剧情链](clef-cloud-acceptance-report.json) 验证候选判断、幂等、原子剧情提交、后台抽取／观察／索引、再次召回和取消。判断审计记录实际候选调用及概率，未以零候选通过代替判断。取消后等待确认任务仍终止，分支序号未推进。

[模型对照报告](live-evaluation-report.json) 完成 433 次模型调用、三方案各 128 份回答。严格答案通过为近期原文 58、摘要 100、混合记忆 109，失败保留。抽取／向量质量及未达门槛的说明见 [评测说明](evaluation.md)。模型失败、未知和未判定预测不会被自动算作正确；原始输出和固定 gold 保留。

独立最终审查未发现未处理的 P0/P1。获取证明的保守句法可能拒绝复杂表达，模型判断也不能代替确定性来源、知情和事务校验。真实生产长会话、概率校准和自动抽取 ≥95% 门槛仍需后续实测与改进。

最终依赖审计 `npm audit --json` 返回 0 个已知漏洞，格式检查通过。云端验收使用的临时 Access 策略及服务 token 已撤销，本地认证头文件已移除，预览保留正式所有者的 Access 规则。
