# Light RP

世界观为中心的轻量多角色 RP 引擎。Web 跑在 **Cloudflare Worker**，工作区（世界观、角色卡、世界书、对局）存在 **R2**。模型默认 **NVIDIA NIM / moonshotai/kimi-k3**。提示词仍是 Markdown 文件。

成人正文只写 R2，不写入 Nowledge Mem。选了 nmem 工作区时只同步 MEMORY / PLAYER 事实并召回，**不会**把对局 transcript 写进 Mem；未选则什么都不写，也不会默写 default。

## 快速开始（Worker）

```bash
cd web
npm install
# 本地密钥：web/.dev.vars（NVIDIA_API_KEY、NMEM_API_KEY）
npm run dev
```

浏览器打开 Vite 给出的地址（默认 http://127.0.0.1:5173）。一键部署：

```bash
# 仓库根目录的 .cloudflare-token，或环境变量 CLOUDFLARE_API_TOKEN
bash scripts/deploy-worker.sh
```

当前部署：https://lightrp.shengyuanzhang-zuens2020.workers.dev

工作区页可导入 SillyTavern **chara_card_v2 JSON / PNG** 和 **World Info**（`entries` 为数组或 uid 字典、关键词字段为 `key`）。角色卡保留原始 JSON，含 character_book。

```bash
cd web
npx wrangler secret put NVIDIA_API_KEY
npx wrangler secret put NMEM_API_KEY
bash ../scripts/deploy-worker.sh
```

每个工作区可单独编辑 WORLD.md、角色卡、世界书。默认开启 **R18G 破甲**（成年虚构，禁未成年）：`layers/breach.md` + `layers/breach_user.md`。

本地 Python CLI 仍可用（文件系统世界包，不经过 R2）：

```bash
pip install -e ".[dev]"
lightrp play lamp-harbor
```

## 命令

| 命令 | 作用 |
|------|------|
| `lightrp play <world>` | 进入世界 |
| `lightrp init [name]` | 复制示例世界 |
| `lightrp import-card FILE --world NAME` | 导入 YAML / ST JSON / PNG |
| `lightrp import-lore FILE --world NAME` | 导入世界书 |
| `lightrp import-library SRC_ID --world NAME` | 从 nmem library 拉文件 |
| `lightrp spaces` | 列出 nmem 工作区 |
| `lightrp prompts [world]` | 显示实际加载的提示词路径 |
| `lightrp serve` | 启动 Web UI（默认 127.0.0.1:8000） |

对局里：`/help` `/quit` `/compact` `/space` `/scene` `/memory` `/status` `/prompts`。`@角色名` 会对该角色做一次 spotlight 调用。

## 世界包

```
WORLD.md          # 世界设定（稳定层）
PLAYER.md         # 玩家人设（§ 条目）
MEMORY.md         # 世界记忆（§ 条目）
SCENE.md          # 当前场景 YAML
cast.yaml         # 演员表
world.yaml        # id / name / nmem_space
characters/       # 角色卡
lorebooks/        # ST 世界书
prompts/          # 覆盖引擎提示词（可选）
sessions/         # 对局 transcript
```

角色卡支持 Hermes YAML、SillyTavern v2/v3 JSON、PNG `chara`/`ccv3`。世界书按关键词与场景实体触发，受 token budget 限制。角色书优先于世界书。

## 提示词

发给模型的文字不写在 Python 里。覆盖顺序（后者覆盖前者）：

1. `src/lightrp/prompts/`（包默认）
2. `~/.lightrp/prompts/`
3. `<world>/prompts/`

改 `gm.md` / `spotlight.md` / `layers/*.md` 等即可改口吻，不必改代码。缺文件会报错，没有内置备用提示词。

## 记忆

启用 nmem 且已选工作区时，MEMORY / PLAYER 事实会按 `space_id` 写入该空间并在下一轮召回。对局正文只在 R2。未选择空间时不同步，也不会写入 default。

## 开发

```bash
pytest
cd web && npm install && npm run build
```
