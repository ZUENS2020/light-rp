# 生成任务卡死：排查与修复

时间均为北京时间（UTC+8）。

## 现象

Worker Queue 消费者拿到租约后中途取消，D1 任务长期停在 `running`；重复投递在租约占用期间短时间 `retry`，耗尽 Queue 重试机会后无人再回收。

## 防复发（已合入 main 的最小集）

- 每 1 分钟 cron（`*/1 * * * *`）回收过期租约；从未启动的 `pending`（`attempt_count=0`）在约 30s 后强制清空 outbox `published_at` 并重新投递，避免 Queue 丢消息后卡在「生成中」；已租约任务仍按 `DELIVERY_GRACE_MS=180s` 回收。空闲 tick 不写 D1。
- 同一 D1 batch 中重置 outbox `published_at` 与任务状态；健康租约不会被回收。
- 占用中租约的重复投递直接 `ack`，由 D1 定时恢复兜底，不再空耗 Queue 重试。
- 最多四次真实执行（`attempt_count`），耗尽后标 `dead` 并释放会话占用。

完整提交阶段 journal 重放仍留在 `codex/local-sync-2026-09-05`，未整支合并（避免冲掉破甲与其它大重构）。

## 2026-09-19 补充：丢失 Queue 的假卡死

确认案例：任务已 `pending`、`attempt_count=0`、outbox `generation.requested` 已有 `published_at`，但 Queue 投递丢失。旧逻辑只 flush `published_at IS NULL`，要等 180s grace + `*/5` cron 才清标记，用户长时间「生成中」且零 LLM 调用。

修复：`flushGenerationOutbox` 对从未启动的 pending 在 `PENDING_NEVER_STARTED_GRACE_MS=30s` 后强制重置 outbox 并 republish；cron 改为 `*/1`。`insertPending` 同步写入 outbox，HTTP play/rewrite 走 `publishTask`。

剩余墙钟时间仍主要来自 GLM（Gateway→OpenRouter，非流式）；本修复只消除队列架构造成的假卡死。
