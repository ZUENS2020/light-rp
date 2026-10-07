# LightRP 3

LightRP 是基于 Cloudflare 的无服务器多角色叙事工作台。一个叙事模型组织整场剧情；角色卡、世界书、角色各自的认知和有来源的长期记忆共同约束生成。故事线下可以创建多个聊天和相互隔离的分支。

此版本从旧代码重写。运行数据使用独立的 V3 Cloudflare 资源，旧站和旧资料保留；本次旧资料迁移只恢复角色卡、世界书，已在本地与独立远程预览验证。真实云端生成、抽取、观察、索引和召回链已跑通，128 题三路模型对照已完成。自动抽取质量尚未达到验收门槛，结果和失败记录均保留。

## 已实现

- 多角色卡、玩家身份和角色聚焦；角色卡/世界书按 revision 绑定到分支，编辑后显式应用新版本。
- Character Card V2/V3 JSON、PNG 导入导出，保留原始未知字段和 PNG 图像 chunks；世界书关键词、选择逻辑、稳定概率、递归、位置与预算，以及服务端触发预览。
- 事件与原文作为来源，记忆逐字引用 Unicode 片段；事实、角色信念、关系、情节、观察和程序经验分别保存。作者纠正把原文、版本替换、依赖失效和后续任务一次提交；来源删除使相关派生记忆失效。
- 按故事线跨聊天召回，词法、向量、实体关系和近期补尾结合；角色知情使用原文片段授权，导演真相不会自动成为所有角色的知识。
- 有能力证据、适用条件、实际步骤、结果和反例的经验层。相同条件和方法至少两次独立执行成功、具备可用能力且没有未决失败，才自动启用程序经验。
- Durable Object 流式任务与 Workflows 后台整理。支持取消、失败重试、幂等提交、分叉和重新生成；上下文检查器显示召回、证据、预算和资料版本。
- 可选 Clef / Clef-flash 判断模型，在确定性来源校验后逐候选检查证据支持；不确定或拒绝时保留生成草稿，知情权限仍由数据库证明与校验。实测和复现方式见 [Clef 接入说明](docs/clef.md)。

完整格式边界见 [迁移与兼容说明](docs/migration.md)。CHARX、全部 ST 插件/宏、V3 媒体资源执行不在当前兼容范围；未知字段保留不意味着应用会执行该字段。

## 本地运行

使用 Node.js 24 和 npm。首次运行：

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run preview
```

打开 `http://127.0.0.1:8787`。示例配置使用 `AUTH_MODE=local`、`MODEL_MODE=local-demo`，只接受回环地址；演示生成会明确显示没有调用远程模型。本地资源位于 `.wrangler/`，配置与数据目录均不提交。

`npm run dev` 只启动 Vite 前端开发服务；需要完整接口、D1、R2、DO 和 Workflows 时使用上述 Wrangler 预览。修改前端后需重新构建预览，或改用 Vite 开发流程配合后端。

```sh
npm run check
npx playwright install --with-deps chromium
npm run test:e2e
```

`check` 执行绑定类型生成、TypeScript、Vitest、生产构建和中文记忆回放。Playwright 使用真实本地 Worker 及浏览器，按现有配置启动并迁移本地环境。GitHub CI 使用 Node.js 24 执行相同检查，并保存浏览器失败报告；[checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[upload-artifact](https://github.com/actions/upload-artifact) 使用官方 action 的固定 SHA。

## Cloudflare 运行资源

| Binding          | 当前 V3 资源                     | 用途                                        |
| ---------------- | -------------------------------- | ------------------------------------------- |
| `DB`             | `lightrp-v3` D1                  | 事件、来源、版本、授权、分支、任务和 outbox |
| `BUCKET`         | `lightrp-v3` R2                  | 卡片原 PNG、不可变资料 revision、任务产物   |
| `VECTORS`        | `lightrp-v3-bge-m3` Vectorize    | 按 owner、分支和认知者隔离的向量投影        |
| `AI`             | Workers AI / AI Gateway          | embedding 与远程模型调用                    |
| `BRANCH_RUNTIME` | SQLite Durable Object            | 分支提交入口、流式快照与撤销记录            |
| `GENERATION`     | `lightrp-v3-generation` Workflow | 上下文、叙事、验证、原子提交                |
| `MEMORY`         | `lightrp-v3-memory` Workflow     | 记忆写入、经验、观察、索引及删除清理        |
| `ASSETS`         | Worker 静态资源                  | React 应用                                  |

`wrangler.jsonc` 定义部署绑定、SQLite DO migration 和每分钟 outbox 派发。生产身份使用 Cloudflare Access JWT 的 issuer/audience 校验，owner 由服务器取得；设置 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 后启用独立 Access 入口。本地身份模式不能用于远程服务。

远程预览：[lightrp-preview.zuens2020.work](https://lightrp-preview.zuens2020.work)，由 Cloudflare Access 保护，仅配置的身份可进入。独立 D1/R2/Vectorize、DO 和 Workflows 已部署；正式域名未切换。

模型设置支持 AI Gateway 和公开 HTTPS 的 OpenAI 兼容接口。默认使用已验证的 Workers AI `@cf/qwen/qwen3-30b-a3b-fp8`。Gateway 的凭证由其配置管理；直接接口的 `MODEL_API_KEY` 使用 Worker secret。统一叙事模型外可以设置辅助验证/压缩模型；没有逐角色独立生成进程。敏感 API 响应禁止缓存，远程模型请求不使用 Gateway 缓存或收集正文日志。

部署前配置独立资源和 Access，应用远程 V3 migrations，再构建部署。不要把 V3 migrations 应用到旧 D1，也不要让新代码绑定旧 R2。远程预览的资料恢复已完成；切换正式域名属于单独的发布操作，本仓库的 CI 不部署。

## 验证与资料迁移

中文合成回放包含 8 个故事、957 次提交（948 个主线回合），其中一条主线连续回放 500 回合；128 个问题有明确预期答案。执行真实 `Store` / `MemoryEngine` 与 SQLite/FTS5。当前回放全部通过，越权、失效原文引用、token 超预算均为 0。该回放没有测真实 LLM 抽取精确率、问答正确率或真实 Vectorize 语义质量。

真实 Qwen 对照完成 433 次模型调用、384 份回答：近期原文严格通过 58/128（45.31%）、摘要 100/128（78.13%）、混合记忆 109/128（85.16%），请求失败均为 0。严格通过按预设答案片段与 unknown 标志计分，不能当成人工语义盲评；混合记忆仍有 19 道失败。各方案 24 道角色／片段隔离问题没有测出泄露。历史旧值的禁止片段命中另列，不混称角色泄密。人工 gold 记忆用于该对照，不代表自动抽取质量。范围与全部失败题见 [评测说明](docs/evaluation.md) 与 [完整模型报告](docs/live-evaluation-report.json)。

真实托管链 smoke 使用上述 Qwen 模型，叙事任务和记忆任务均完成，事实与观察可召回，见 [云端记录](docs/cloud-smoke-workers-ai-report.json)。实际 bge-m3 / Vectorize 的 20 题固定小语料 Recall@10 为 100%，三条秘密／删除／分支反向用例通过。[Qwen 自动抽取 20 例](docs/model-quality-qwen-prompt-report.json) 的固定事实命中仅 2/13，并记录同一案例 3 条 episode 知情风险候选。新版原文知情 proof 与 Llama70B 辅助抽取只完成 1 例成功探针，其余 19 例因中断及临时凭证到期尚未运行；[最新抽取报告](docs/model-quality-report.json) 为 partial，完整精确率和 ≥95% 门槛仍为 null。单例结果不能证明完整质量或新版授权修复已通过实测。

2026-10-05 已备份旧 D1 SQL 和 70 个旧 R2 对象，合计 50,301,745 字节；9 张角色卡和 1 本世界书已恢复到本地 V3，并在远程预览的正式 Access 身份下完成 10/10 指纹及不可变 revision 比对。14 个聊天文件仅归档，9 张卡在该备份中没有原 PNG。记录与校验路径见 [迁移快照](docs/migration-snapshot.md)，操作步骤见 [迁移说明](docs/migration.md)。

进一步阅读：[架构](docs/architecture.md)、[任务与数据恢复](docs/recovery.md)。项目代码使用 [MIT License](LICENSE)。
