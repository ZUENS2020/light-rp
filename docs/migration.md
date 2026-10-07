# 旧资料离线迁移

迁移只接收用户提供的离线备份目录，脚本不连接旧 D1、旧 R2 或任何生产服务。只导入角色卡和世界书；旧聊天、事件日志和场景文件单独归档，不转换成新故事、记忆或经验。旧派生 Mini 卡和自动记忆不迁入运行数据。所有操作默认 dry-run。

离线备份可包含原项目的 `characters/*.json|yaml|png`、`lorebooks/*.json|yaml`、独立卡片/世界书 JSON，以及 `sessions/**`。YAML 使用标准解析器并限制 alias。卡内世界书随角色保存。角色同路径同名 JSON 和 PNG 合并为一份资料，以 JSON 内容为准、保留原 PNG；JSON 中未识别字段不会删除。

```sh
npx tsx scripts/migrate-legacy.ts plan --input /absolute/path/to/offline-backup
```

输出资料数、跳过项、错误、单独归档的会话路径，以及 `missingPng`。缺图不会阻止 JSON 迁移；如果旧版只保存了 PNG 内的 JSON，无法凭 metadata 恢复画像。报告只说明该备份中没有原图，不声称图已从所有地方丢失。补入同路径同名 PNG 后重新规划即可。

确认报告后，生成全新迁移包；输出目录不能已存在，也不能位于旧备份内部。

```sh
npx tsx scripts/migrate-legacy.ts plan --input /absolute/path/to/offline-backup --output /absolute/path/to/new-bundle --write
```

迁移包包含 `manifest.json`、`assets/*.json|png` 和 `archive/conversations/**`。manifest 保存 SHA-256 校验信息。旧备份不改动；错误资料留在报告中，不会用空卡替代。生成包后的会话归档可独立查看，恢复过程不会上传会话归档。应保留旧完整备份，因为不属于角色/世界书或会话的配置、自动记忆不会复制到迁移包。

先验证恢复包，默认不会请求网络或写入：

```sh
npx tsx scripts/migrate-legacy.ts restore --input /absolute/path/to/new-bundle
```

这一步读取 manifest，校验所有资产 JSON/PNG 的 hash、资料类型和原始 JSON 身份，重新验证 PNG chunks，输出 `would-import` 和缺图报告。如果指定本地目标，dry-run 额外通过 GET 比较已有迁移指纹，不发送 POST：

```sh
npx tsx scripts/migrate-legacy.ts restore --input /absolute/path/to/new-bundle --target http://127.0.0.1:8787
```

启动配置了 `AUTH_MODE=local` 的本地应用，执行实际恢复：

```sh
npm run db:local
npm run preview
# 另一个终端：
npx tsx scripts/migrate-legacy.ts restore --input /absolute/path/to/new-bundle --target http://127.0.0.1:8787 --write
```

恢复走真实的 `/api/v3/assets` JSON/multipart 接口，由应用创建 D1 资料和 revision、写入新 R2 key。PNG 中的卡 metadata 会更新为迁移 JSON，原始图像与其他 chunks 保留。指纹存于 `extensions.lightrp.migrationFingerprint`；恢复中断后重试会跳过已导入资料，不覆盖已有资料。只允许 localhost/127.0.0.1/::1 回环服务，不接受生产地址、URL 密码或远程秘钥。成功输出含原资料 ID 到新 ID 的映射。

旧数据不会被覆盖，远程迁移和部署也不在脚本范围内。撤销本地试迁移可以另启全新本地数据库/存储环境；不应删除旧备份或用旧 bucket 名覆盖新 revision。

# 格式兼容边界

支持 Character Card V2/V3 JSON、PNG `chara`/`ccv3`（优先 V3），额外读取压缩 zTXt/iTXt。完整原始 JSON 独立保存，明确清空字符串、数组或卡内世界书不会恢复旧 raw 值。导出 JSON 保留未知字段；PNG 导出保留其他 chunks、像素数据和 APNG chunks，但首版界面不播放 APNG 动画。没有原 PNG 时 PNG 导出返回 422，JSON 仍可导出。

世界书支持标准 entries 数组、ST entries 对象、四种 selective logic、常驻、大小写/整词/正则、概率、扫描深度、递归、预算，以及角色前后、作者注释、示例和带 role 的聊天深度位置。`outlet` 和 decorator 原字段保留；当前叙事上下文没有注册 outlet，因此此类条目明确跳过，不改放到其他位置。概率以生成 seed 稳定抽签，传输重试不重抽。整体提示预算是硬上限；`ignoreBudget` 只能绕过单书预算。未知插件字段保存但不会执行插件、宏脚本或自动化；未支持的 timed/group/vector 激活由预览报告跳过原因。正则执行支持安全子集：多个可变量词、量词分组、lookaround、反向引用及超大重复范围保留原字段，但标记为 unsupported 并跳过；限制扫描长度不会单独用作回溯安全保证。完整 CHARX/V3 decorator/媒体资源与 ST 插件运行不在首版兼容范围。
