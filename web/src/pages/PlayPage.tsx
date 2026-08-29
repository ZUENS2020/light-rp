import { ArrowLeft, LoaderCircle, MoreHorizontal, PanelLeft, PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Composer } from "../components/Composer";
import { SessionList } from "../components/SessionList";
import { SettingsLink } from "../components/SettingsLink";
import { ThemeToggle } from "../components/ThemeToggle";
import { Transcript } from "../components/Transcript";
import { WorldPanel } from "../components/WorldPanel";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../components/ui/sheet";
import { api, type PlayState, type SessionInfo } from "../lib/api";

function formatError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : fallback;
  if (message.includes("missing API base URL")) return "还没有配置 API 地址。打开设置填写你的兼容端点。";
  if (message.includes("missing API model")) return "还没有配置模型 id。打开设置填写。";
  if (message.includes("missing API key")) return "还没有配置 API 密钥。打开设置填写，或设置对应的环境变量。";
  return message || fallback;
}

export function PlayPage() {
  const { worldId = "", sessionId = "" } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<PlayState | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);

  async function loadPlay() {
    const next = await api.play(worldId, sessionId);
    setState(next);
    setSessions(next.world.sessions || []);
  }

  useEffect(() => {
    let cancelled = false;
    setError("");
    api
      .play(worldId, sessionId)
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setSessions(next.world.sessions || []);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [worldId, sessionId]);

  async function send(text: string) {
    setBusy(true);
    setError("");
    try {
      const next = await api.turn(worldId, sessionId, text);
      setState(next);
      setSessions(next.world.sessions || []);
    } catch (err) {
      setError(formatError(err, "发送失败"));
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function compact() {
    setBusy(true);
    setError("");
    setMenuOpen(false);
    try {
      const next = await api.compact(worldId, sessionId);
      setState(next);
    } catch (err) {
      setError(formatError(err, "压缩失败"));
    } finally {
      setBusy(false);
    }
  }

  async function setPrimary(characterId: string) {
    setBusy(true);
    setError("");
    try {
      const next = await api.patchSession(worldId, sessionId, { primary_character: characterId || null });
      if ("session_id" in next) {
        setState(next as PlayState);
        setSessions((next as PlayState).world.sessions || []);
      } else {
        await loadPlay();
      }
    } catch (err) {
      setError(formatError(err, "切换主卡失败"));
    } finally {
      setBusy(false);
    }
  }

  async function createSession() {
    setCreating(true);
    try {
      const next = await api.open(worldId, { new: true, space: state?.world.nmem_space || state?.nmem_space || null });
      navigate(`/w/${worldId}/s/${next.session_id}`);
    } catch (err) {
      setError(formatError(err, "无法开局"));
    } finally {
      setCreating(false);
    }
  }

  if (!state && !error) {
    return (
      <div className="flex min-h-dvh items-center justify-center font-ui text-secondary">
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden />
        载入对局…
      </div>
    );
  }

  if (!state) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <p className="text-destructive">{error}</p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate("/")}>
          返回工作区列表
        </Button>
      </div>
    );
  }

  const list = (
    <SessionList
      worldId={worldId}
      sessions={sessions}
      activeId={sessionId}
      compact
      creating={creating}
      onCreate={() => void createSession()}
      onRename={async (id, title) => {
        await api.renameSession(worldId, id, title);
        const data = await api.sessions(worldId);
        setSessions(data.sessions);
        if (id === sessionId) await loadPlay();
      }}
      onDelete={async (id) => {
        await api.deleteSession(worldId, id);
        if (id === sessionId) {
          navigate(`/w/${worldId}`);
          return;
        }
        const data = await api.sessions(worldId);
        setSessions(data.sessions);
      }}
    />
  );
  const panel = <WorldPanel state={state} />;
  const primaryId = state.primary_character || state.world.primary || "";

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <a href="#transcript" className="skip-link">
        跳到正文
      </a>
      <header className="sticky top-0 z-header flex items-center gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`/w/${worldId}`} aria-label="返回工作区">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-xl font-semibold">{state.world.name}</h1>
          <p className="truncate font-ui text-xs text-secondary">
            {state.session_title || "新会话"}
            {state.nmem_space ? ` · nmem ${state.nmem_space}` : " · nmem 未选择"}
          </p>
        </div>
        <label className="hidden items-center gap-2 font-ui text-xs text-secondary sm:flex">
          <span className="shrink-0">主卡</span>
          <select
            className="h-9 max-w-[10rem] rounded-md border border-border bg-background px-2 text-foreground"
            value={primaryId}
            disabled={busy}
            aria-label="切换本局主卡"
            onChange={(event) => void setPrimary(event.target.value)}
          >
            <option value="">默认</option>
            {state.world.cast.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="icon"
          aria-label={leftOpen ? "收起会话列表" : "打开会话列表"}
          aria-pressed={leftOpen}
          className="hidden lg:inline-flex"
          onClick={() => setLeftOpen((value) => !value)}
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
        <div className="lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="打开会话列表">
                <PanelLeft className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetTitle>会话</SheetTitle>
              <div className="mt-8 flex min-h-0 flex-1 flex-col overflow-hidden">{list}</div>
            </SheetContent>
          </Sheet>
        </div>
        <div className="relative">
          <Button variant="ghost" size="icon" aria-label="更多" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontal className="h-5 w-5" />
          </Button>
          {menuOpen ? (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[8rem] border border-border bg-background p-1 shadow-sm">
              <button
                type="button"
                className="flex w-full px-3 py-2 text-left font-ui text-sm hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={() => void compact()}
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
              <Button variant="ghost" size="icon" aria-label="打开场面">
                <PanelRight className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetTitle>场面</SheetTitle>
              <div className="mt-8 overflow-y-auto">{panel}</div>
            </SheetContent>
          </Sheet>
        </div>
        <ThemeToggle />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className={`min-h-0 w-72 shrink-0 flex-col border-r border-border ${leftOpen ? "hidden lg:flex" : "hidden"}`}>{list}</aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {error ? (
            <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 font-ui text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {(state.warnings.length > 0 || (state.turn_warnings && state.turn_warnings.length > 0)) && (
            <p className="border-b border-border px-4 py-2 font-ui text-sm text-secondary">
              {[...state.warnings, ...(state.turn_warnings || [])].join(" · ")}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Transcript state={state} />
            {state.context_report ? (
              <div className="border-t border-border px-4 py-3 font-ui text-xs text-secondary">
                <button type="button" className="font-medium text-foreground" onClick={() => setCtxOpen((v) => !v)}>
                  Context {ctxOpen ? "▾" : "▸"} {state.context_report.total.toLocaleString()} /{" "}
                  {state.context_report.max_tokens.toLocaleString()}
                </button>
                {ctxOpen ? (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed text-foreground">
                    {[
                      `Total: ${state.context_report.total.toLocaleString()} / ${state.context_report.max_tokens.toLocaleString()}`,
                      `Reserve: ${state.context_report.generation_reserve}`,
                      "",
                      ...state.context_report.sections.map(
                        (section) =>
                          `${section.name.padEnd(14)} ${String(section.tokens).padStart(6)} / ${section.budget}${section.truncated ? "  truncated" : ""}${
                            section.items?.length ? `  [${section.items.slice(0, 4).join(", ")}]` : ""
                          }`,
                      ),
                      "",
                      `History       ${state.context_report.history.tokens}  msgs=${state.context_report.history.messages}${
                        state.context_report.history.truncated ? "  truncated" : ""
                      }`,
                      `Input         ${state.context_report.input.tokens}`,
                    ].join("\n")}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="z-composer">
            <Composer cast={state.world.cast} disabled={busy} onSend={send} />
          </div>
        </main>
        <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border p-4 xl:block">{panel}</aside>
      </div>
    </div>
  );
}
