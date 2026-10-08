# 语言模型提示词缓存

本次优化针对当前 Command Code 直连的 `deepseek/deepseek-v4.1-flash` 输入缓存。叙事仍每次重新生成，模型地址、输出预算和资料绑定规则沿用用户设置。

叙事上下文从稳定到易变排列：Hermes 前置层、全局规则与玩家约定 → 按稳定 ID 排列的绑定资料及卡前／卡后世界书 → 示例与近期原文 → 当前场景、观察、导演证据与角色认知 → 当前输入及后置指令。世界书继续按激活结果及指定位置注入；聊天深度按原文消息计数，不把后移的动态系统块算作历史消息。预算预留包含所有后移内容。

抽取验证器的固定提示词不再拼接每轮变化的实体注册表。请求 JSON 先放角色 ID 和冻结的硬规则，再放实体解析、模式、场景、召回候选和原文。修复请求沿用原始数据，追加失败诊断，不修改事实或规则。

每轮仍读取有效版本并检查来源、分支、知情权限和删除水位。资料变更、世界书触发、历史窗口移动会缩短可复用前缀；不能为提高命中率省略新场景、复用旧召回或继续发送已删除的来源。[DeepSeek 官方缓存说明](https://api-docs.deepseek.com/guides/kv_cache/)指出前缀匹配与持久化由模型服务控制，命中采用尽力而为方式。[Command Code Provider API](https://commandcode.ai/docs/provider)提供兼容 Chat Completions 的直连端点；服务宣传的整体命中率不能代表 LightRP 的实际表现。

## 实测

[完整数据](./model-cache-live-report.json)使用实际 `buildContext`、内存 SQLite 和真实 Command Code 模型；两种布局各运行三次，场景、当前输入和已提交合成历史逐次改变。长角色卡为合成档案，无用户剧情、身份或预览数据库写入。旧布局通过把当前场景和模式重新插到首条系统消息中重建。六次请求均完整返回。

| 请求 | 旧场景前置布局      | 稳定前缀布局               |
| ---- | ------------------- | -------------------------- |
| 1    | 0 / 4157 tokens，0% | 0 / 4157 tokens，0%        |
| 2    | 0 / 4179 tokens，0% | 4096 / 4179 tokens，98.01% |
| 3    | 0 / 4201 tokens，0% | 4096 / 4201 tokens，97.50% |

预热后的两次请求合计命中率为 97.76%；包含首轮冷请求的三次合计为 65.34%。这是小样本合成测试，不是正式故事的长期命中率或延迟改善保证。生成耗时还受输出及推理长度影响，不能从本测试推导稳定的加速比例。

## 观测与复测

直连 Command Code 的流式请求启用 `stream_options.include_usage`。服务端读取最终 usage，识别 DeepSeek 的 `prompt_cache_hit_tokens`／`prompt_cache_miss_tokens` 和兼容格式的 `prompt_tokens_details.cached_tokens`。结构化日志 `model_prompt_cache` 记录模型、调用阶段、输入／命中／未命中／输出 token 和命中率；缺少或矛盾的缓存计数记为 `null`，不当作零。日志不包含提示词、正文、密钥或提供商附加字段。

在 Cloudflare Worker 日志中按事件名及模型筛选，叙事、结构化抽取分别统计。汇总使用 `sum(cachedTokens) / sum(inputTokens)`，只纳入缓存计数可用的请求，同时报告缺失计数请求数量；不要平均每次的百分比。`responseReadMs` 仅表示读取响应的耗时，不包含等待响应头的网络时间。

可选实测命令：先在环境中提供 `MODEL_API_KEY`，再执行 `npm run eval:cache -- /tmp/model-cache-report.json`。可通过 `CACHE_EVAL_MODEL` 指定兼容模型。该命令会产生六次真实模型调用，只写脱敏 token 报告。没有缓存计数或未完整返回时退出非零，不自动重试消耗额度，也不启动额外生产预热请求。
