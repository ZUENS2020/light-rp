# 任务与数据恢复

先区分叙事任务、记忆整理和存储故障。浏览器断开不会自动取消后台 Workflow；重新进入故事后查看任务状态及 SSE 快照。不要因页面暂时没有新文字重复提交相同剧情。

## 任务恢复

| 症状                     | 查看位置                     | 当前恢复方式                                                                   |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------ |
| 生成失败，草稿仍在       | `GET /api/v3/tasks/:id`      | 保留草稿；若 branch head 未变化，`POST /api/v3/tasks/:id/retry` 创建新 attempt |
| 已取消                   | 同上                         | 重新提交新 commandId；取消的 task 不能原地 retry                               |
| 提交版本冲突             | task error、当前 branch head | 刷新后重新提交，或从原输入前分叉；不要覆盖其他已提交回合                       |
| 正文已提交，记忆暂未出现 | `GET /api/v3/jobs`           | 等待 memory outbox；失败的非 generation job 使用 `POST /api/v3/jobs/:id/retry` |
| `MEMORY_BACKLOG`         | jobs 及上下文检查器          | 先让失败/积压的记忆整理完成，再重试；近期窗口不能覆盖的未整理事件不会被忽略    |
| 语义索引不可用           | 上下文 warnings              | 词法、关系和原文补尾仍工作；检查索引任务并恢复 Vectorize/AI binding            |
| `ENTITY_AMBIGUOUS`       | memory job error             | 明确人物 ID/别名或纠正原文后处理；系统不会随机合并同名人物                     |
| 原 PNG 不存在            | 资产 `hasPng`、PNG 导出 422  | 导出 JSON；提供原 PNG 后重新导入/补充，metadata 无法合成原画像                 |

普通重试会生成新的 Workflow identity 或 task attempt，旧步骤仍受来源与提交 fence 约束。不要直接把 D1 中 task 改成 completed，也不要把 outbox 强制完成来掩盖 cursor 缺口。调度器每分钟尝试派发 pending outbox，并检查超过 15 分钟的 dispatched 工作流终止状态；已终止任务会报告失败，保留可检查状态。

用同一个 commandId 重试同一 HTTP 提交是幂等重放；改变输入必须使用新 commandId。重新生成已提交回合先从其输入前创建分支，原分支保留原稿与记忆前缀。

## 纠正、遗忘和删除

作者纠正生成新原文及记忆 revision，并使旧结论的依赖失效。遗忘表示当前分支不再使用该项记忆，原文仍可留存。删除原文是更强操作：相关 source/spans、派生记忆、经验/能力证据、场景副本及旧任务副本被清理，其他分支也不能继续引用。

删除先在 D1 中执行失效和 generation/epoch 变更，再通过 durable cleanup 清理 R2、DO 流、embedding cache 和 Vectorize 投影。整理任务晚于删除写回时仍检查旧 fence；查询端也检查来源状态。因此外部索引清理暂时失败不应让旧文本进入有效召回。检查 `/api/v3/jobs`，重试 failed cleanup/index job，直到后台完成；不要通过重新插入旧 source/embedding 绕过删除账本。

## 备份范围

保存至少三类内容：D1 完整导出、R2 原对象及校验清单、部署版本与资源配置。D1 包含来源、事件、分支、授权、能力、procedure uses、游标及任务意图；只备份聊天正文无法完整恢复这些关系。R2 的 PNG 与任务产物也不能仅凭 D1 文件还原。

`GET /api/v3/branches/:id/export` 导出整个故事及其分支、事件、可见记忆、来源和 grants，用于用户归档；当前没有对应的完整故事 archive 导入 API。导出包括所有不可变记忆历史、lineage/水位、资料绑定和原始 JSON revision、能力/使用账本、实体、来源与证据及删除审计。PNG 以外部 R2 key 清单表示，不内嵌文件；它仍不是完整 D1/R2/DO 备份，不包含任务产物或 Workflow 运行状态。导出过程中剧情、投影或删除版本改变会返回 409，需要重新导出。Vectorize 是可重新生成的投影，但可用 `POST /api/v3/branches/:id/rebuild` 按已提交原文重建当前分支，输入包含 commandId 和 expectedHead；仍没有公开的一键全库重建接口。

旧版已完成的备份与本地资料恢复见 [迁移快照](migration-snapshot.md)。该快照在备份目录中，未纳入 Git。用户的离线完整备份和应用中的删除是不同保存范围；恢复旧备份前应核对其时间和删除记录，防止重新导入后来删除的原文。

## 隔离恢复

1. 暂停向待恢复环境写入，记录 Worker 版本、各资源标识及最近完成的 outbox 状态。保留原环境和当前备份。
2. 在全新恢复用资源中校验 D1 导出和每个 R2 对象的 hash。旧 V2 SQL 用于旧版恢复；不能导入 V3 schema 或直接执行 V3 migrations。V3 恢复也需匹配对应代码与 migrations。
3. 使用同一批次的 D1 与 R2 备份恢复，再核对来源、revision、角色授权、分支头和 cursor。新的 DO 流由 D1 task 草稿重新读取；恢复时保留可检查的 task/outbox，不能假定旧 Workflow execution 会自动迁到新 binding。
4. 旧资料升级使用离线迁移脚本，只恢复卡片/世界书到全新 V3，详见 [迁移步骤](migration.md)。旧聊天仅归档；不要把自动记忆当作已验证 V3 记忆导入。
5. 本地执行 `npm run check` 和 `npm run test:e2e`，核对资料数、PNG 缺失、来源与分支隔离。独立远程预览已配置 Access，真实 Workers AI 生成及记忆链已完成一次 smoke；恢复环境仍须独立测试连接、生成、取消、记忆整理和来源清理，合成回放不替代这一步。

当前迁移 CLI 只允许回环目标，没有生产恢复或部署命令。2026-10-07 的远程预览恢复通过独立 D1 的受控操作完成，并在服务器内逐项比对 fingerprint 和 immutable revision，见 [远程记录](migration-preview-report.json)。正式切换需要操作人员选择已核验的资源与版本；CI 仅检查代码与本地环境，不执行存储恢复或部署。
