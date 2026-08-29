import { LoaderCircle, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Input, Label } from "../components/ui/field";
import { api, type WorldSummary } from "../lib/api";

export function HomePage() {
  const navigate = useNavigate();
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [setupHint, setSetupHint] = useState("");
  const [removing, setRemoving] = useState<WorldSummary | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    return api
      .worlds()
      .then((data) => setWorlds(data.worlds))
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    void load();
    api
      .settings()
      .then((data) => {
        const missing: string[] = [];
        if (!data.llm.base_url) missing.push("API 地址");
        if (!data.llm.model) missing.push("模型");
        if (!data.llm.api_key_set) missing.push("密钥");
        setSetupHint(missing.length ? missing.join("、") : "");
      })
      .catch(() => setSetupHint(""));
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!worlds) return [];
    if (!needle) return worlds;
    return worlds.filter((world) => {
      const hay = `${world.name} ${world.id} ${world.cast.map((m) => m.name).join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [worlds, query]);

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[clamp(2.25rem,5vw,3.25rem)] font-semibold leading-tight tracking-tight">
              工作区
            </h1>
            <p className="mt-3 max-w-xl font-body text-lg leading-relaxed text-secondary">
              一个世界一份设定。先进工作区，再开会话。
            </p>
          </div>
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            新工作区
          </Button>
        </div>

        <div className="relative mt-8 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" aria-hidden />
          <Input
            className="pl-10"
            value={query}
            placeholder="搜索世界或角色"
            aria-label="搜索工作区"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {setupHint ? (
          <p className="mt-6 rounded-xl border border-border bg-surface px-4 py-3 font-ui text-sm text-secondary">
            还没有配置 {setupHint}。
            <Link className="ml-2 text-accent underline-offset-4 hover:underline" to="/settings">
              打开设置
            </Link>
          </p>
        ) : null}
        {error ? (
          <p className="mt-6 font-ui text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {!worlds ? (
          <div className="mt-12 flex items-center gap-2 font-ui text-secondary">
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden />
            读取工作区…
          </div>
        ) : filtered.length === 0 ? (
          <p className="mt-12 text-secondary">
            {worlds.length === 0 ? "还没有工作区。点右上角「新工作区」。" : "没有匹配的工作区。"}
          </p>
        ) : (
          <ul className="mt-10 grid gap-4 sm:grid-cols-2">
            {filtered.map((world, index) => (
              <li
                key={world.id}
                className="rounded-xl border border-border bg-surface p-6 shadow-sm transition-shadow duration-200 hover:shadow-md motion-safe:animate-[fadein_0.35s_ease-out]"
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <Link to={`/w/${world.id}`} className="block">
                  <h2 className="font-display text-2xl font-semibold">{world.name}</h2>
                  <p className="mt-1 font-ui text-xs text-secondary">{world.id}</p>
                  <p className="mt-3 font-ui text-sm text-secondary">
                    {world.cast.map((member) => member.name).join(" · ") || "还没有角色卡"}
                  </p>
                  <p className="mt-2 font-ui text-xs text-secondary">{world.session_count || 0} 个会话</p>
                </Link>
                <div className="mt-5 flex flex-wrap gap-2">
                  <Button type="button" onClick={() => navigate(`/w/${world.id}`)}>
                    打开
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={opening}
                    onClick={() => {
                      setOpening(true);
                      api
                        .open(world.id, { new: true, space: world.nmem_space || null })
                        .then((state) => navigate(`/w/${world.id}/s/${state.session_id}`))
                        .catch((err: Error) => setError(err.message))
                        .finally(() => setOpening(false));
                    }}
                  >
                    开新局
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除 ${world.name}`}
                    onClick={() => setRemoving(world)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogTitle>新工作区</DialogTitle>
          <DialogDescription>id 用小写字母和连字符。名称可以中文。</DialogDescription>
          <form
            className="mt-6 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const id = newId.trim().toLowerCase();
              setOpening(true);
              api
                .createWorld({ id, name: newName.trim() || id })
                .then(() => {
                  setCreating(false);
                  setNewId("");
                  setNewName("");
                  navigate(`/w/${id}`);
                })
                .catch((err: Error) => setError(err.message))
                .finally(() => setOpening(false));
            }}
          >
            <Label htmlFor="ws-id">id</Label>
            <Input id="ws-id" value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="lamp-harbor" />
            <Label htmlFor="ws-name">名称</Label>
            <Input id="ws-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="灯港" />
            <Button type="submit" disabled={opening || !newId.trim()}>
              创建
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        title="删除工作区？"
        description={removing ? `「${removing.name}」的角色卡、世界书和会话都会从 R2 删掉。` : ""}
        busy={busy}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          setBusy(true);
          api
            .deleteWorld(removing.id)
            .then(() => {
              setRemoving(null);
              return load();
            })
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
