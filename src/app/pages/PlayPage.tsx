import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BrainCircuit,
  DatabaseZap,
  Gauge,
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Composer } from "../components/Composer";
import { SessionList } from "../components/SessionList";
import { SettingsLink } from "../components/SettingsLink";
import { ThemeToggle } from "../components/ThemeToggle";
import { Transcript } from "../components/Transcript";
import { WorldPanel } from "../components/WorldPanel";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../components/ui/sheet";
import {
  api,
  TaskConflictError,
  type AiModelConfig,
  type CacheReport,
  type MemoryStatus,
  type PlayState,
} from "../lib/api";
import { parseSystemCommand, SYSTEM_COMMANDS } from "../../core/commands";

function formatError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function CacheInspector({
  state,
  cache,
  memoryStatus,
  model,
  models,
  modelLocked,
  onModelChange,
  onMemorySync,
  memorySyncing,
}: {
  state: PlayState;
  cache?: CacheReport;
  memoryStatus?: MemoryStatus;
  model?: AiModelConfig;
  models: AiModelConfig[];
  modelLocked: boolean;
  onModelChange: (id: string) => void;
  onMemorySync: () => void;
  memorySyncing: boolean;
}) {
  const [tab, setTab] = useState<"scene" | "memory" | "cache">("scene");
  const report = state.context_report;
  const ratio = Math.round((cache?.prefix_cache_ratio || 0) * 100);
  const status = cache?.response_cache_status || "unknown";
  return (
    <section aria-label="上下文检查器" className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border p-4 md:hidden">
        <label className="space-y-2 font-ui text-xs text-secondary">
          <span className="block">下一条消息使用的模型</span>
          <select
            className="field-control w-full"
            value={model?.id || ""}
            disabled={modelLocked || !model}
            aria-label="移动端选择下一条消息使用的模型"
            onChange={(event) => onModelChange(event.target.value)}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {model ? (
          <p className="mt-2 font-mono text-[11px] text-secondary">
            {model.transport === "cloudflare" ? "workers-ai" : model.provider_slug} ·{" "}
            {(model.context_window / 1_000).toFixed(0)}K · {model.supports_tools ? "tools" : "text"}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-3 border-b border-border p-1">
        <button
          type="button"
          className={`min-h-10 rounded-sm px-3 font-ui text-xs font-medium ${tab === "scene" ? "bg-muted text-foreground" : "text-secondary"}`}
          aria-pressed={tab === "scene"}
          onClick={() => setTab("scene")}
        >
          场景
        </button>
        <button
          type="button"
          className={`min-h-10 rounded-sm px-3 font-ui text-xs font-medium ${tab === "memory" ? "bg-muted text-foreground" : "text-secondary"}`}
          aria-pressed={tab === "memory"}
          onClick={() => setTab("memory")}
        >
          记忆
        </button>
        <button
          type="button"
          className={`min-h-10 rounded-sm px-3 font-ui text-xs font-medium ${tab === "cache" ? "bg-muted text-foreground" : "text-secondary"}`}
          aria-pressed={tab === "cache"}
          onClick={() => setTab("cache")}
        >
          缓存
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "scene" ? (
          <WorldPanel
            state={state}
            disabled={false}
            onSaveMemory={(value) => api.saveMemory(state.world.id, value).then(() => undefined)}
          />
        ) : null}
        {tab === "memory" ? (
          <div className="space-y-5 font-ui text-sm">
            <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-secondary">Hermes memory lifecycle</p>
                <p className="mt-1 font-medium">{memoryStatus?.sync?.space_id || state.nmem_space || "rp-mem"}</p>
              </div>
              <span className="cache-status">{memoryStatus?.sync?.status || "ready"}</span>
            </div>
            <Metric
              icon={BrainCircuit}
              label="核心记忆"
              value={String(
                (memoryStatus?.core.world || 0) +
                  (memoryStatus?.core.player || 0) +
                  (memoryStatus?.core.character || 0),
              )}
              detail={`世界 ${memoryStatus?.core.world || 0} · 玩家 ${memoryStatus?.core.player || 0} · 角色 ${memoryStatus?.core.character || 0}`}
            />
            <Metric
              icon={DatabaseZap}
              label="本轮召回"
              value={String(memoryStatus?.recall?.recalled_count || 0)}
              detail={memoryStatus?.recall ? `来自 ${memoryStatus.recall.space_id}` : "尚无召回记录"}
            />
            <div className="border-t border-border pt-4">
              <p className="text-xs text-secondary">核心记忆保持有界；nmem 只在每轮按需召回，生成提交后异步同步。</p>
              {memoryStatus?.sync?.error ? (
                <p className="mt-2 text-xs text-destructive">{memoryStatus.sync.error}</p>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="mt-4 w-full"
                disabled={memorySyncing}
                onClick={onMemorySync}
              >
                {memorySyncing ? "正在同步…" : "重新同步到 RP-mem"}
              </Button>
            </div>
          </div>
        ) : null}
        {tab === "cache" ? (
          <div className="space-y-5 font-ui text-sm">
            <div className="flex items-center justify-between border-b border-border pb-4">
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-secondary">Gateway response</p>
                <p className="mt-1 font-medium">{status}</p>
              </div>
              <span className={`cache-status cache-status-${status.toLowerCase()}`}>{status}</span>
            </div>
            <Metric
              icon={Gauge}
              label="Prompt cache ratio"
              value={`${ratio}%`}
              detail={`${cache?.cached_input_tokens || 0} / ${cache?.prompt_tokens || 0} tokens`}
            />
            <Metric
              icon={DatabaseZap}
              label="稳定前缀"
              value={(cache?.stable_prefix_tokens || 0).toLocaleString()}
              detail="system + epoch checkpoint"
            />
            <Metric
              icon={BrainCircuit}
              label="动态增量"
              value={(cache?.volatile_tokens || 0).toLocaleString()}
              detail={`epoch ${cache?.prompt_epoch || 1}`}
            />
            <Metric
              icon={SlidersHorizontal}
              label="输出契约"
              value={(cache?.output_contract_tokens || 0).toLocaleString()}
              detail="固定且不参与压缩"
            />
            {report ? (
              <div className="border-t border-border pt-4 text-xs text-secondary">
                <p>
                  上下文估算 {report.total.toLocaleString()} / {report.max_tokens.toLocaleString()}
                </p>
                <div className="mt-3 space-y-2">
                  {report.sections.map((section) => (
                    <div key={section.name} className="flex items-center justify-between gap-3">
                      <span>{section.name}</span>
                      <span className="font-mono text-[11px] text-foreground">{section.tokens.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="grid grid-cols-[2rem_1fr_auto] items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 text-accent" aria-hidden />
      <div>
        <p className="font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs text-secondary">{detail}</p>
      </div>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

export function PlayPage() {
  const { worldId = "", sessionId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [taskId, setTaskId] = useState<string | null>(null);
  const [optimisticText, setOptimisticText] = useState("");
  const [leftOpen, setLeftOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [commandHelpOpen, setCommandHelpOpen] = useState(false);

  const playQuery = useQuery({ queryKey: ["play", worldId, sessionId], queryFn: () => api.play(worldId, sessionId) });
  const modelsQuery = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 60_000 });
  const modelQuery = useQuery({
    queryKey: ["session-model", sessionId],
    queryFn: () => api.sessionModel(sessionId),
    enabled: Boolean(sessionId),
  });
  const cacheQuery = useQuery({
    queryKey: ["session-cache", sessionId],
    queryFn: () => api.cache(sessionId),
    enabled: Boolean(sessionId),
  });
  const memoryQuery = useQuery({
    queryKey: ["session-memory", sessionId],
    queryFn: () => api.memoryStatus(sessionId),
    enabled: Boolean(sessionId),
  });
  const activeQuery = useQuery({
    queryKey: ["active-task", sessionId],
    queryFn: () => api.activeTask(sessionId),
    enabled: Boolean(sessionId) && !taskId,
    refetchInterval: taskId ? false : 5_000,
  });
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.task(taskId || ""),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" || !status ? 1_500 : false;
    },
  });
  const state = playQuery.data;

  useEffect(() => {
    const active = activeQuery.data?.task;
    if (active && (active.status === "pending" || active.status === "running")) setTaskId(active.id);
  }, [activeQuery.data]);

  useEffect(() => {
    const task = taskQuery.data;
    if (!task || task.status === "pending" || task.status === "running") return;
    if (task.status === "completed") {
      setOptimisticText("");
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["play", worldId, sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-cache", sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-memory", sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["models"] }),
        queryClient.invalidateQueries({ queryKey: ["active-task", sessionId] }),
      ]).then(() => setTaskId(null));
    }
  }, [queryClient, sessionId, taskQuery.data, worldId]);

  const turnMutation = useMutation({
    mutationFn: (text: string) => api.turn(sessionId, text, crypto.randomUUID()),
    onMutate: (text) => setOptimisticText(text),
    onSuccess: (accepted) => setTaskId(accepted.task_id),
    onError: async (error) => {
      if (error instanceof TaskConflictError) {
        setOptimisticText("");
        setTaskId(error.task_id);
        return;
      }
      setOptimisticText("");
    },
  });

  const modelMutation = useMutation({
    mutationFn: (id: string) => api.setSessionModel(sessionId, id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["session-model", sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-cache", sessionId] }),
      ]);
    },
  });

  const rewriteMutation = useMutation({
    mutationFn: ({ index, content }: { index: number; content: string }) =>
      api.rewrite(worldId, sessionId, index, content),
    onSuccess: async (next) => {
      queryClient.setQueryData(["play", worldId, sessionId], next);
      if (next.task_id) setTaskId(next.task_id);
    },
  });

  const memorySyncMutation = useMutation({
    mutationFn: () => api.syncMemory(worldId, state?.nmem_space || "rp-mem"),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["play", worldId, sessionId] }),
        queryClient.invalidateQueries({ queryKey: ["session-memory", sessionId] }),
      ]);
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: () => api.regenerate(sessionId, crypto.randomUUID()),
    onSuccess: (accepted) => setTaskId(accepted.task_id),
  });

  const compactMutation = useMutation({
    mutationFn: () => api.compact(worldId, sessionId),
    onSuccess: (next) => queryClient.setQueryData(["play", worldId, sessionId], next),
  });

  const primaryMutation = useMutation({
    mutationFn: (characterId: string) =>
      api.patchSession(worldId, sessionId, { primary_character: characterId || null }),
    onSuccess: refreshPlay,
  });

  const activeStatus = taskQuery.data?.status;
  const busy =
    turnMutation.isPending ||
    regenerateMutation.isPending ||
    compactMutation.isPending ||
    modelMutation.isPending ||
    primaryMutation.isPending ||
    activeStatus === "pending" ||
    activeStatus === "running";
  const taskFailure =
    taskQuery.data && (taskQuery.data.status === "failed" || taskQuery.data.status === "dead")
      ? taskQuery.data.error || "生成失败"
      : "";
  const error =
    taskFailure ||
    formatError(
      playQuery.error ||
        turnMutation.error ||
        regenerateMutation.error ||
        compactMutation.error ||
        modelMutation.error ||
        rewriteMutation.error ||
        memorySyncMutation.error,
      "",
    );

  async function runComposerCommand(text: string) {
    const command = parseSystemCommand(text);
    if (!command || command.name === "ooc") {
      await turnMutation.mutateAsync(text);
      return;
    }
    if (command.name === "help") {
      setCommandHelpOpen(true);
      return;
    }
    if (command.name === "regenerate") {
      await regenerateMutation.mutateAsync();
      return;
    }
    if (command.name === "compact") {
      await compactMutation.mutateAsync();
      return;
    }
    if (command.name === "sync-memory") {
      await memorySyncMutation.mutateAsync();
    }
  }

  const displayed = useMemo<PlayState | undefined>(() => {
    if (!state || !optimisticText) return state;
    const last = state.messages[state.messages.length - 1];
    if (last?.role === "user" && last.content === optimisticText) return state;
    return {
      ...state,
      messages: [...state.messages, { role: "user", content: optimisticText, ts: new Date().toISOString() }],
    };
  }, [optimisticText, state]);

  async function createSession() {
    if (!state) return;
    const next = await api.open(worldId, { new: true, space: state.world.nmem_space || state.nmem_space || null });
    navigate(`/w/${worldId}/s/${next.session_id}`);
  }

  async function refreshPlay() {
    await queryClient.invalidateQueries({ queryKey: ["play", worldId, sessionId] });
  }

  if (playQuery.isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center font-ui text-secondary">
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden />
        载入工作室…
      </div>
    );
  }

  if (!displayed) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <p className="text-destructive" role="alert">
          {error || "会话不存在"}
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate("/")}>
          返回工作区列表
        </Button>
      </div>
    );
  }

  const sessions = displayed.world.sessions || [];
  const model = modelQuery.data?.model;
  const models = modelsQuery.data?.models.filter((item) => item.enabled) || [];
  const primaryId = displayed.primary_character || displayed.world.primary || "";
  const list = (
    <SessionList
      worldId={worldId}
      sessions={sessions}
      activeId={sessionId}
      compact
      creating={false}
      onCreate={() => void createSession()}
      onRename={async (id, title) => {
        await api.renameSession(worldId, id, title);
        await refreshPlay();
      }}
      onDelete={async (id) => {
        await api.deleteSession(worldId, id);
        if (id === sessionId) navigate(`/w/${worldId}`);
        else await refreshPlay();
      }}
    />
  );
  const inspector = (
    <CacheInspector
      state={displayed}
      cache={cacheQuery.data}
      memoryStatus={memoryQuery.data}
      model={model}
      models={models}
      modelLocked={busy}
      onModelChange={(id) => modelMutation.mutate(id)}
      onMemorySync={() => memorySyncMutation.mutate()}
      memorySyncing={memorySyncMutation.isPending}
    />
  );

  return (
    <div className="studio-shell flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <a href="#transcript" className="skip-link">
        跳到正文
      </a>
      <header className="bg-background/95 z-header flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-3 backdrop-blur md:px-5">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/w/${worldId}`} aria-label="返回工作区">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight">{displayed.world.name}</h1>
          <p className="truncate font-ui text-xs text-secondary">
            {displayed.session_title || "新会话"} · epoch {cacheQuery.data?.prompt_epoch || 1}
          </p>
        </div>
        <label className="model-picker hidden min-w-0 items-center gap-2 md:flex">
          <span className="sr-only">运行模型</span>
          <select
            value={model?.id || ""}
            disabled={busy || !model}
            aria-label="选择下一条消息使用的模型"
            onChange={(event) => modelMutation.mutate(event.target.value)}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {model ? (
            <span className="hidden max-w-48 truncate text-[11px] text-secondary xl:inline">
              {model.transport === "cloudflare" ? "Workers AI" : model.provider_slug} ·{" "}
              {(model.context_window / 1000).toFixed(0)}K {model.supports_tools ? "· tools" : ""}
            </span>
          ) : null}
        </label>
        <label className="hidden items-center gap-2 font-ui text-xs text-secondary 2xl:flex">
          <span>主卡</span>
          <select
            className="h-10 max-w-36 border border-border bg-surface px-2 text-foreground"
            value={primaryId}
            disabled={busy}
            aria-label="选择本局主卡"
            onChange={(event) => primaryMutation.mutate(event.target.value)}
          >
            <option value="">工作区默认</option>
            {displayed.world.cast.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="icon"
          aria-label={leftOpen ? "收起资源导航" : "展开资源导航"}
          className="hidden lg:inline-flex"
          onClick={() => setLeftOpen((value) => !value)}
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
        <div className="lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="打开资源导航">
                <PanelLeft className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetTitle>会话与资源</SheetTitle>
              <nav aria-label="工作区资源" className="mt-6 grid grid-cols-2 gap-2 font-ui text-sm">
                <Link className="min-h-11 border border-border px-3 py-3" to={`/w/${worldId}/world`}>
                  世界
                </Link>
                <Link className="min-h-11 border border-border px-3 py-3" to={`/w/${worldId}/cards`}>
                  角色
                </Link>
                <Link className="min-h-11 border border-border px-3 py-3" to={`/w/${worldId}/lore`}>
                  世界书
                </Link>
                <Link className="min-h-11 border border-border px-3 py-3" to="/settings">
                  设置
                </Link>
              </nav>
              <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border pt-2">
                {list}
              </div>
            </SheetContent>
          </Sheet>
        </div>
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            aria-label="会话操作"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <MoreHorizontal className="h-5 w-5" />
          </Button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-modal mt-1 min-w-36 border border-border bg-surface p-1 shadow-md">
              <button
                type="button"
                className="min-h-11 w-full px-3 text-left font-ui text-sm hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  void api
                    .compact(worldId, sessionId)
                    .then((next) => queryClient.setQueryData(["play", worldId, sessionId], next));
                }}
              >
                压缩会话
              </button>
            </div>
          ) : null}
        </div>
        <SettingsLink />
        <div className="xl:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="打开上下文检查器">
                <PanelRight className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle>上下文检查器</SheetTitle>
              <div className="mt-4 min-h-0 flex-1 overflow-hidden">{inspector}</div>
            </SheetContent>
          </Sheet>
        </div>
        <ThemeToggle />
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {leftOpen ? (
          <aside className="bg-surface/55 hidden w-64 shrink-0 flex-col border-r border-border lg:flex">{list}</aside>
        ) : null}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {error ? (
            <p
              className="border-destructive/30 bg-destructive/10 border-b px-4 py-2 font-ui text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Transcript
              state={displayed}
              pending={busy}
              disabled={busy}
              onRewrite={(index, content) => rewriteMutation.mutate({ index, content })}
            />
          </div>
          <div className="z-composer">
            {commandHelpOpen ? (
              <section
                className="mx-auto max-w-[42rem] border-x border-t border-border bg-surface px-4 py-3"
                aria-label="系统命令"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-sm font-semibold">系统命令</h2>
                  <button
                    type="button"
                    className="min-h-10 px-2 font-ui text-xs text-secondary hover:text-foreground"
                    onClick={() => setCommandHelpOpen(false)}
                  >
                    关闭
                  </button>
                </div>
                <div className="mt-2 grid gap-1">
                  {SYSTEM_COMMANDS.map((command) => (
                    <p key={command.name} className="grid grid-cols-[8rem_1fr] gap-3 font-ui text-xs">
                      <span className="font-mono text-foreground">{command.usage}</span>
                      <span className="text-secondary">{command.description}</span>
                    </p>
                  ))}
                </div>
              </section>
            ) : null}
            <Composer
              disabled={busy}
              onSend={async (text) => {
                await runComposerCommand(text);
              }}
            />
          </div>
        </main>
        <aside className="bg-surface/40 sticky top-0 hidden h-full w-80 shrink-0 self-start overflow-hidden border-l border-border xl:block">
          {inspector}
        </aside>
      </div>
      <div className="sr-only" aria-live="polite">
        {busy ? "模型正在生成，模型选择已锁定" : "可以发送消息"}
      </div>
    </div>
  );
}
