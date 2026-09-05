# 生成任务卡死：排查与修复

时间均为北京时间（UTC+8）。

## 现象

Worker Queue 消费者拿到租约后中途取消，D1 任务长期停在 `running`；重复投递在租约占用期间短时间 `retry`，耗尽 Queue 重试机会后无人再回收。

## 防复发（已合入 main 的最小集）

- 每分钟 cron 回收过期租约，以及超过三分钟仍未取得租约的 `pending`/`running` 任务。
- 同一 D1 batch 中重置 outbox `published_at` 与任务状态；健康租约不会被回收。
- 占用中租约的重复投递直接 `ack`，由 D1 定时恢复兜底，不再空耗 Queue 重试。
- 最多四次真实执行（`attempt_count`），耗尽后标 `dead` 并释放会话占用。

完整提交阶段 journal 重放仍留在 `codex/local-sync-2026-09-05`，未整支合并（避免冲掉破甲与其它大重构）。
