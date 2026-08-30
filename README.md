# Light RP V2

Light RP 是一个单用户私有的多角色 RP Studio。前端、Cloudflare Worker、领域逻辑、内容工具与测试均使用 TypeScript，运行在 React + Vite + Cloudflare Workers 上。

V2 使用 D1 保存事务数据，R2 保存角色卡、世界书、提示词覆盖、附件和导出包，Queues 负责生成与 nmem 同步。AI 请求统一经过现有 `sillytavern` AI Gateway，并可按会话在运行时切换模型。

记忆系统采用 Hermes 风格的分层生命周期：`PLAYER.md` 是用户维护且不可被模型改写的设定，`PLAYER_MEMORY.md`、`MEMORY.md` 与角色记忆是有字符上限的核心快照；每轮只对有语义信号的输入从 `RP-mem` 按世界标签召回，生成提交后再由独立 Queue 幂等同步正文、线程和核心记忆。压缩前会先提取持久事实，召回与同步状态保存在 D1 并显示于上下文检查器。

## 本地运行

```bash
npm install
npm run dev
```

本地敏感变量放在根目录 `.dev.vars`：

```dotenv
NMEM_API_KEY=...
```

不要把 `.dev.vars` 提交到仓库。AI Gateway 通过同账户的 Worker AI binding 预认证；OpenRouter、opg 等上游凭据继续由 Gateway BYOK 管理，Worker 不保存 Gateway 或上游 token。

## 架构

```text
src/app         React Studio
src/server      Worker V2 API、队列消费者与任务
src/core        领域逻辑、预算、提示词规范化与导入
src/adapters    AI Gateway、R2、nmem
src/content     默认系统提示词
migrations      D1 V2 schema
scripts         TypeScript 内容包工具与仓库检查
tests           Vitest、Cloudflare 集成与 Playwright
```

主要存储约定：

- D1：工作区、角色/世界书索引、会话、可见消息、隐藏 LLM 事件、记忆、生成任务、tool 执行与 outbox。
- R2：资源统一放在 `v2/workspaces/`；仓库不再包含 V1 API、示例世界或迁移执行入口。
- `messages` 只含用户可见历史；`llm_events` 保存模型前缀所需的规范化事件，不保存 reasoning。
- 每个会话最多一个活动生成任务；发送回合使用 `Idempotency-Key`，返回 `202 task_id`。

## 模型与缓存

内置模型配置：

- 默认：`@preset/dsf0731-cheap`，经 `openrouter` Gateway BYOK。
- `@cf/moonshotai/kimi-k2.6`，经 Workers AI binding。
- `@cf/openai/gpt-oss-20b`，经 Workers AI binding。

设置页可以登记 OpenRouter、opg 或 Workers AI 模型。新配置通过文本与工具探测后才会启用。模型解析顺序为应用默认 → 工作区默认 → 会话覆盖；切换从下一条消息起生效，已入队任务保留不可变模型快照。

Gateway 整响应缓存 TTL 为 3600 秒。普通叙事、工具循环、摘要、压缩和记忆请求使用完整请求体的默认缓存键；重新生成、重写、输出通道纠错与人工诊断始终绕过缓存。模型探测使用 `model-probe:<revision>` 并缓存 24 小时。

提示词在同一 epoch 内保持 append-only：稳定 system 前缀、固定工具 schema 和输出通道契约不变，动态世界书、状态、nmem 与记忆作为隐藏事件追加。模型、工具、稳定设定或提示词覆盖改变时会创建新 epoch 并轮换 session affinity。

每次模型调用都会加入不可覆盖的输出通道契约，要求应用读取的完整结果进入 `assistant.content` 或正式 `tool_calls`。reasoning 不进入 D1、R2、日志、后续 tool loop 或 UI；连续两次只有 reasoning 时任务以 `LLM_OUTPUT_CHANNEL_VIOLATION` 失败。

## 部署

首次部署前设置 Worker secrets：

```bash
npx wrangler secret put NMEM_API_KEY
```

完整验证与部署：

```bash
npm run check
npx wrangler d1 migrations apply lightrp-v2 --remote
npx wrangler deploy --keep-vars
```

部署后，在 Cloudflare Zero Trust 中把现有 Access allow policy 绑定到 V2 路由。旧 Worker、旧 D1、旧 Queues 与旧 R2 对象已经退役，不再作为运行或回滚路径。

仓库默认关闭 `workers.dev` 与 preview URL，避免在 Access 策略绑定前公开私有应用。准备切流时先创建受 Access 保护的 V2 路由，再把该路由加入 `wrangler.jsonc` 并部署；不要直接开启未受保护的 `workers.dev`。

## 质量检查

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run check
```

`npm run check` 包含格式、ESLint、类型、单元/集成测试、生产构建、四档响应式 Playwright 验收，以及旧运行路径扫描。
