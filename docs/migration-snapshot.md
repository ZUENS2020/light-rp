# 2026-10-05 旧版备份与本地迁移快照

本记录只包含路径、统计、校验值和恢复范围，不包含私人聊天正文、卡片名称或 Access 凭证。旧站资源未用于 V3 写入；此次恢复的目标是本机 V3，独立远程预览已部署在 [lightrp-preview.zuens2020.work](https://lightrp-preview.zuens2020.work)，由 Cloudflare Access 保护；2026-10-07 已在远程预览的正式 Access 身份下恢复并验证 9 张卡、1 本世界书，见 [远程迁移验证](migration-preview-report.json)。正式站未切换。

备份根目录：`/Users/zuens2020/Documents/ChatGPT/LRP-backups/2026-10-05`。文件留在该独立目录，不进入 Git。

| 文件                                              | 内容与检查                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `lightrp-v2-d1.sql`                               | 旧 D1 完整 SQL 导出，32,823,612 字节                                                    |
| `r2/backup-manifest.json`                         | 70 个 R2 对象，每对象记录路径、字节数和 SHA-256；合计 50,301,745 字节                   |
| `v3-migration/manifest.json`                      | 离线迁移包：9 张角色卡、1 本世界书；14 个聊天文件独立归档                               |
| `v3-migration/restore-validation-2026-10-05.json` | 本地恢复后的 GET/dry-run 复核：10/10 `already-restored`，聊天 imported=0，missing PNG=9 |

对应绝对路径：

```text
/Users/zuens2020/Documents/ChatGPT/LRP-backups/2026-10-05/lightrp-v2-d1.sql
/Users/zuens2020/Documents/ChatGPT/LRP-backups/2026-10-05/r2/backup-manifest.json
/Users/zuens2020/Documents/ChatGPT/LRP-backups/2026-10-05/v3-migration/manifest.json
/Users/zuens2020/Documents/ChatGPT/LRP-backups/2026-10-05/v3-migration/restore-validation-2026-10-05.json
```

文件 SHA-256：

```text
lightrp-v2-d1.sql
8a3f913555ab7faba3d6034509a01da7ac478b9c6cc504e5662d313e042d3334

r2/backup-manifest.json
68222bbd9e401b032322315d12e1b87d99c76d445631865e153f24327d2f4b07

v3-migration/manifest.json
fd6e348e18088b1c5fdde5e600979ddc253b9f8f6caa39fe5785e41480c634a6
```

本次 R2 通过 Cloudflare REST 的只读 list/get 逐对象导出，按对象大小与 SHA-256 建立清单，没有向旧 bucket 写入。保存后已重新校验全部 70 个本地对象的大小与 SHA-256，均与清单一致。仓库另提供仅允许回环 GET/list 的 `scripts/legacy-reader.ts` 和离线备份脚本。D1 SQL 是独立完整备份，不是从卡片迁移包反推。

迁移包检查为 10 份资产、14 个会话归档、9 个缺图项、46 个跳过项、0 个解析错误。跳过的配置、旧派生 Mini 卡和自动记忆保留在完整旧备份中，不作为 V3 运行记忆导入。缺图项表示这份备份没有原 PNG，不表示原图在所有位置都不存在；JSON 导入可正常完成，PNG 导出需要另行提供原图。

真实本地恢复已走 `/api/v3/assets` 接口，创建新 D1 资产及 revision，使用迁移 fingerprint 避免重复导入。随后复核请求仅 GET，保存的报告是恢复后的验证结果，不是当时 POST 的操作日志。复核时全部 10 份 fingerprint 在本地资料库中存在。14 个聊天文件未上传到新应用，未转为新故事、记忆、经验或模型训练资料。

这些计数不代表已完成旧聊天续用或模型记忆质量评测。中文检索机制的合成回放结果与未测模型指标见 [评测说明](evaluation.md)。恢复与兼容步骤见 [迁移说明](migration.md)、[故障恢复](recovery.md)。

2026-10-07 远程验证读取独立 `lightrp-v3` D1：10/10 备份 fingerprint 与目标资产匹配，10/10 当前 raw JSON 与 immutable revision 一致；身份由已验证 Access owner 决定。远程同样没有导入旧会话或派生记忆，缺失的 9 份原 PNG 保持为已报告缺图。
