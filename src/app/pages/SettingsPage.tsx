import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleGauge, DatabaseZap, LoaderCircle, Plus, Wrench } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { Button } from "../components/ui/button";
import { Checkbox, Hint, Input, Label } from "../components/ui/field";
import { api, type AiModelConfig, type AppSettings, type SettingsPut } from "../lib/api";

type ModelDraft = Omit<AiModelConfig, "enabled" | "revision" | "source" | "metrics">;

function settingsPayload(data: AppSettings): SettingsPut {
  return {
    llm: {
      temperature: data.llm.temperature,
      max_tokens: data.llm.max_tokens,
      timeout: data.llm.timeout,
      breach: data.llm.breach,
    },
    nmem: { ...data.nmem },
    memory: { ...data.memory },
    worlds_dir: data.worlds_dir,
    home: data.home,
    compact_after_turns: data.compact_after_turns,
    lore_scan_depth: data.lore_scan_depth,
    lore_token_budget: data.lore_token_budget,
    max_tool_rounds: data.max_tool_rounds,
    transcript_keep_after_compact: data.transcript_keep_after_compact,
    context: { ...data.context },
    mini: { ...data.mini },
  };
}

const emptyModel: ModelDraft = {
  id: "",
  label: "",
  transport: "gateway",
  provider_slug: "openrouter",
  model_id: "",
  context_window: 131_072,
  max_output_tokens: 8_192,
  supports_tools: true,
  supports_reasoning: false,
  sort_order: 100,
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const modelsQuery = useQuery({ queryKey: ["models"], queryFn: api.models });
  const spacesQuery = useQuery({ queryKey: ["nmem-spaces"], queryFn: api.spaces });
  const connection = useQuery({
    queryKey: ["nmem-status"],
    queryFn: api.nmemStatus,
    retry: false,
    refetchInterval: 5000,
  });
  const connectionMutation = useMutation({
    mutationFn: (online: boolean) => (online ? api.connectNmem() : api.disconnectNmem()),
    onSuccess: async (state) => {
      queryClient.setQueryData(["nmem-status"], state);
      await queryClient.invalidateQueries({ queryKey: ["nmem-spaces"] });
    },
  });
  const [form, setForm] = useState<SettingsPut | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel);
  const [saved, setSaved] = useState("");
  const [modelMessage, setModelMessage] = useState("");

  useEffect(() => {
    if (settingsQuery.data) setForm(settingsPayload(settingsQuery.data));
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (value: SettingsPut) => api.saveSettings(value),
    onSuccess: (next) => {
      queryClient.setQueryData(["settings"], next);
      setForm(settingsPayload(next));
      setSaved("已保存，下一次请求立即生效。稳定前缀变化会自动创建新 epoch。");
    },
  });

  const modelMutation = useMutation({
    mutationFn: async (draft: ModelDraft) => {
      const registered = await api.registerModel(draft);
      return api.probeModel(registered.model.id);
    },
    onSuccess: async (result) => {
      setModelMessage(
        result.status === "passed" ? `${result.model.label} 已通过文本与工具探测并启用。` : result.error || "探测失败",
      );
      setModelDraft(emptyModel);
      await queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (error) => setModelMessage(error instanceof Error ? error.message : "模型登记失败"),
  });

  const defaultModelMutation = useMutation({
    mutationFn: (modelConfigId: string) => api.setApplicationDefaultModel(modelConfigId),
    onSuccess: async ({ model }) => {
      setModelMessage(`${model.label} 已设为应用默认；继承默认的会话已创建新 prompt epoch。`);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (error) => setModelMessage(error instanceof Error ? error.message : "默认模型切换失败"),
  });

  if (!form || settingsQuery.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center font-ui text-secondary">
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden />
        读取设置…
      </div>
    );
  }

  const settings = settingsQuery.data;
  const error = settingsQuery.error || saveMutation.error;
  const models = modelsQuery.data?.models || [];

  function submitSettings(event: FormEvent) {
    event.preventDefault();
    setSaved("");
    saveMutation.mutate({
      ...form!,
      context: {
        ...form!.context,
        generation_reserve: Math.max(form!.context.generation_reserve, form!.llm.max_tokens),
        tool_reserve: form!.context.tool_reserve ?? 1_500,
      },
    });
  }

  function submitModel(event: FormEvent) {
    event.preventDefault();
    setModelMessage("");
    modelMutation.mutate({
      ...modelDraft,
      id: modelDraft.id.trim(),
      label: modelDraft.label.trim(),
      model_id: modelDraft.model_id.trim(),
      provider_slug: modelDraft.transport === "cloudflare" ? null : modelDraft.provider_slug?.trim() || null,
    });
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-5 pb-24 pt-8 md:px-8">
        <div className="max-w-2xl">
          <p className="font-ui text-xs uppercase tracking-[0.16em] text-accent">Runtime control</p>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight">设置</h1>
          <p className="mt-3 font-body text-secondary">
            AI 已绑定 Gateway{" "}
            <span className="font-mono text-sm text-foreground">{settings?.llm.gateway_id || "sillytavern"}</span>。
            Worker 通过账户内预认证的 AI binding 调用，上游密钥继续留在 Gateway BYOK。
          </p>
        </div>
        {error ? (
          <p
            className="border-destructive/30 bg-destructive/10 mt-5 border px-4 py-3 font-ui text-sm text-destructive"
            role="alert"
          >
            {error instanceof Error ? error.message : "读取失败"}
          </p>
        ) : null}
        {saved ? (
          <p className="mt-5 font-ui text-sm text-accent" role="status">
            {saved}
          </p>
        ) : null}

        <section className="bg-surface/70 mt-10 border border-border">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <div>
              <h2 className="font-display text-2xl font-semibold">运行时模型</h2>
              <p className="mt-1 font-ui text-xs text-secondary">会话标题栏可切换；任务入队后保存不可变快照。</p>
            </div>
            <span className="font-mono text-xs text-secondary">{models.length} configs</span>
          </div>
          <div className="grid gap-2 border-b border-border px-5 py-4 sm:grid-cols-[12rem_1fr] sm:items-center">
            <Label htmlFor="application-default-model">应用默认模型</Label>
            <select
              id="application-default-model"
              className="field-control"
              value={settings?.llm.default_model_config_id || ""}
              disabled={defaultModelMutation.isPending}
              onChange={(event) => {
                setModelMessage("");
                defaultModelMutation.mutate(event.target.value);
              }}
            >
              {models
                .filter((model) => model.enabled)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.provider_slug || "workers-ai"}
                  </option>
                ))}
            </select>
          </div>
          <div className="divide-y divide-border">
            {models.map((model) => {
              const metrics = model.metrics;
              return (
                <article key={model.id} className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-ui text-sm font-semibold">{model.label}</h3>
                      <span className={`cache-status ${model.enabled ? "cache-status-hit" : "cache-status-bypass"}`}>
                        {model.enabled ? "ENABLED" : "PROBE"}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-secondary">
                      {model.provider_slug || "workers-ai"} / {model.model_id}
                    </p>
                    <p className="mt-2 font-ui text-xs text-secondary">
                      {(model.context_window / 1_000).toFixed(0)}K context · {model.supports_tools ? "tools" : "text"} ·
                      rev {model.revision}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-5 text-right font-ui text-xs">
                    <ModelMetric
                      icon={CircleGauge}
                      label="缓存率"
                      value={`${Math.round((metrics?.prefix_cache_ratio || 0) * 100)}%`}
                    />
                    <ModelMetric
                      icon={DatabaseZap}
                      label="节省"
                      value={(metrics?.estimated_saved_tokens || 0).toLocaleString()}
                    />
                    <ModelMetric
                      icon={CheckCircle2}
                      label="冷启动"
                      value={(metrics?.cold_starts || 0).toLocaleString()}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <form className="bg-surface/40 mt-6 border border-border p-5" onSubmit={submitModel}>
          <div className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-accent" aria-hidden />
            <h2 className="font-ui text-sm font-semibold">登记 Gateway / Workers AI 模型</h2>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field id="model-id" label="配置 ID">
              <Input
                id="model-id"
                required
                pattern="[a-z0-9][a-z0-9-]+"
                value={modelDraft.id}
                onChange={(event) => setModelDraft({ ...modelDraft, id: event.target.value })}
                placeholder="claude-sonnet-opg"
              />
            </Field>
            <Field id="model-label" label="显示名称">
              <Input
                id="model-label"
                required
                value={modelDraft.label}
                onChange={(event) => setModelDraft({ ...modelDraft, label: event.target.value })}
              />
            </Field>
            <Field id="model-transport" label="传输">
              <select
                id="model-transport"
                className="field-control"
                value={modelDraft.transport}
                onChange={(event) =>
                  setModelDraft({
                    ...modelDraft,
                    transport: event.target.value as ModelDraft["transport"],
                    provider_slug: event.target.value === "cloudflare" ? null : "openrouter",
                  })
                }
              >
                <option value="gateway">Gateway BYOK</option>
                <option value="cloudflare">Workers AI binding</option>
              </select>
            </Field>
            <Field id="provider-slug" label="Provider slug">
              <Input
                id="provider-slug"
                disabled={modelDraft.transport === "cloudflare"}
                value={modelDraft.provider_slug || ""}
                onChange={(event) => setModelDraft({ ...modelDraft, provider_slug: event.target.value })}
                placeholder="openrouter / opg"
              />
            </Field>
            <Field id="upstream-model" label="模型 ID">
              <Input
                id="upstream-model"
                required
                value={modelDraft.model_id}
                onChange={(event) => setModelDraft({ ...modelDraft, model_id: event.target.value })}
                placeholder="vendor/model or @cf/..."
              />
            </Field>
            <Field id="context-window" label="Context window">
              <Input
                id="context-window"
                type="number"
                min={1}
                value={modelDraft.context_window}
                onChange={(event) => setModelDraft({ ...modelDraft, context_window: Number(event.target.value) })}
              />
            </Field>
            <Field id="model-output" label="最大输出">
              <Input
                id="model-output"
                type="number"
                min={1}
                value={modelDraft.max_output_tokens}
                onChange={(event) => setModelDraft({ ...modelDraft, max_output_tokens: Number(event.target.value) })}
              />
            </Field>
            <Checkbox
              id="model-tools"
              checked={modelDraft.supports_tools}
              onChange={(checked) => setModelDraft({ ...modelDraft, supports_tools: checked })}
            >
              工具调用
            </Checkbox>
            <Checkbox
              id="model-reasoning"
              checked={modelDraft.supports_reasoning}
              onChange={(checked) => setModelDraft({ ...modelDraft, supports_reasoning: checked })}
            >
              推理模型
            </Checkbox>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={modelMutation.isPending}>
              {modelMutation.isPending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Wrench className="h-4 w-4" aria-hidden />
              )}
              {modelMutation.isPending ? "探测中" : "登记并探测"}
            </Button>
            {modelMessage ? (
              <p className="font-ui text-sm text-secondary" role="status">
                {modelMessage}
              </p>
            ) : null}
          </div>
        </form>

        <form className="mt-12 space-y-10" onSubmit={submitSettings}>
          <fieldset className="settings-section">
            <legend>生成策略</legend>
            <Checkbox
              id="breach"
              checked={form.llm.breach}
              onChange={(checked) => setForm({ ...form, llm: { ...form.llm, breach: checked } })}
            >
              破甲 · 叙事风格
            </Checkbox>
            <Hint>生活化对白与动作优先，默认 400–800 字，不代控玩家。只影响正文风格，不注入记忆或压缩任务。</Hint>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField
                id="temperature"
                label="温度"
                value={form.llm.temperature}
                step={0.05}
                min={0}
                onChange={(value) => setForm({ ...form, llm: { ...form.llm, temperature: value } })}
              />
              <NumberField
                id="max-tokens"
                label="最大输出 tokens"
                value={form.llm.max_tokens}
                min={1}
                onChange={(value) => setForm({ ...form, llm: { ...form.llm, max_tokens: value } })}
              />
              <NumberField
                id="timeout"
                label="超时（秒）"
                value={form.llm.timeout}
                min={1}
                onChange={(value) => setForm({ ...form, llm: { ...form.llm, timeout: value } })}
              />
            </div>
          </fieldset>

          <fieldset className="settings-section">
            <legend>Nowledge Mem</legend>
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="font-ui text-sm">{connection.data?.status === "online" ? "在线" : "离线"}</p>
                <Hint>待补传 {connection.data?.pending ?? 0} 回合 · 离线后静默停用，仅手动上线恢复。</Hint>
              </div>
              <Button
                type="button"
                disabled={connectionMutation.isPending}
                onClick={() => connectionMutation.mutate(connection.data?.status !== "online")}
              >
                {connectionMutation.isPending ? "检测中" : connection.data?.status === "online" ? "下线" : "上线"}
              </Button>
            </div>
            <Field id="nmem-space" label="默认空间" hint="上线后按顺序补传真实会话，并同步当前核心记忆。">
              <Input
                id="nmem-space"
                list="nmem-spaces"
                value={form.nmem.space}
                onChange={(event) => setForm({ ...form, nmem: { ...form.nmem, space: event.target.value } })}
              />
              <datalist id="nmem-spaces">
                {(spacesQuery.data?.spaces || []).map((space) => (
                  <option key={space.id} value={space.id}>
                    {space.name}
                  </option>
                ))}
              </datalist>
            </Field>
          </fieldset>

          <fieldset className="settings-section">
            <legend>预算与记忆</legend>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField
                id="context"
                label="总 context"
                value={form.context.max_tokens}
                min={1_024}
                onChange={(value) => setForm({ ...form, context: { ...form.context, max_tokens: value } })}
              />
              <NumberField
                id="reserve"
                label="生成预留"
                value={form.context.generation_reserve}
                min={256}
                onChange={(value) => setForm({ ...form, context: { ...form.context, generation_reserve: value } })}
              />
              <NumberField
                id="tool-reserve"
                label="工具预留"
                value={form.context.tool_reserve || 0}
                min={0}
                onChange={(value) => setForm({ ...form, context: { ...form.context, tool_reserve: value } })}
              />
              <NumberField
                id="world-memory"
                label="世界记忆字符"
                value={form.memory.world_char_limit}
                min={1}
                onChange={(value) => setForm({ ...form, memory: { ...form.memory, world_char_limit: value } })}
              />
              <NumberField
                id="player-memory"
                label="玩家记忆字符"
                value={form.memory.player_char_limit}
                min={1}
                onChange={(value) => setForm({ ...form, memory: { ...form.memory, player_char_limit: value } })}
              />
              <NumberField
                id="character-memory"
                label="角色记忆字符"
                value={form.memory.character_char_limit}
                min={1}
                onChange={(value) => setForm({ ...form, memory: { ...form.memory, character_char_limit: value } })}
              />
              <NumberField
                id="compact-after"
                label="压缩阈值"
                value={form.compact_after_turns}
                min={1}
                onChange={(value) => setForm({ ...form, compact_after_turns: value })}
              />
              <NumberField
                id="lore-budget"
                label="世界书 tokens"
                value={form.lore_token_budget}
                min={1}
                onChange={(value) => setForm({ ...form, lore_token_budget: value })}
              />
              <NumberField
                id="tool-rounds"
                label="工具轮次"
                value={form.max_tool_rounds}
                min={1}
                onChange={(value) => setForm({ ...form, max_tool_rounds: value })}
              />
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {saveMutation.isPending ? "保存中" : "保存参数"}
            </Button>
            <Button variant="secondary" asChild>
              <Link to="/">返回工作区</Link>
            </Button>
            <span className="font-mono text-xs text-secondary">{settings?.path}</span>
          </div>
        </form>
      </main>
    </div>
  );
}

function ModelMetric({ icon: Icon, label, value }: { icon: typeof CircleGauge; label: string; value: string }) {
  return (
    <div>
      <Icon className="ml-auto h-3.5 w-3.5 text-accent" aria-hidden />
      <p className="mt-1 text-secondary">{label}</p>
      <p className="mt-0.5 font-mono text-foreground">{value}</p>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}
