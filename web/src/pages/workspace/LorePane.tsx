import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button } from "../../components/ui/button";
import { Hint, Input, Label, Textarea } from "../../components/ui/field";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";

export function LorePane({
  worldId,
  lorebooks,
  onReload,
}: {
  worldId: string;
  lorebooks: { name: string; text: string }[];
  onReload: () => Promise<void>;
}) {
  const [name, setName] = useState(lorebooks[0]?.name || "");
  const [text, setText] = useState(lorebooks[0]?.text || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [removing, setRemoving] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);

  useEffect(() => {
    if (creatingNew) return;
    setName((currentName) => {
      if (currentName && lorebooks.some((item) => item.name === currentName)) return currentName;
      const next = lorebooks[0];
      setText(next?.text || "");
      return next?.name || "";
    });
  }, [lorebooks, creatingNew]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const dest = name.trim() || "world.json";
    setBusy(true);
    setError("");
    try {
      await api.saveLorebook(worldId, dest, text);
      setCreatingNew(false);
      await onReload();
      setName(dest);
      setSaved("世界书已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="rounded-xl border border-border bg-surface p-2">
        {lorebooks.length === 0 ? (
          <p className="px-3 py-6 font-ui text-sm text-secondary">还没有世界书。</p>
        ) : null}
        <ul>
          {lorebooks.map((item) => (
            <li key={item.name}>
              <button
                type="button"
                className={cn(
                  "flex min-h-11 w-full cursor-pointer items-center rounded-lg px-3 py-2 text-left font-ui text-sm transition-colors duration-200",
                  name === item.name ? "bg-muted" : "hover:bg-muted/70",
                )}
                onClick={() => {
                  setCreatingNew(false);
                  setName(item.name);
                  setText(item.text);
                }}
              >
                <span className="truncate">{item.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          variant="secondary"
          className="mt-2 w-full"
          onClick={() => {
            setCreatingNew(true);
            setName("");
            setText('{\n  "entries": {}\n}\n');
          }}
        >
          新世界书
        </Button>
      </aside>
      <form className="space-y-4" onSubmit={(event) => void save(event)}>
        <Hint>SillyTavern World Info JSON。entries 可以是数组或 uid 字典，关键词字段是 key。</Hint>
        {error ? (
          <p className="font-ui text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="font-ui text-sm text-accent" role="status">
            {saved}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="lore-name">文件名</Label>
          <Input id="lore-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="harbor.json" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lore-text">内容</Label>
          <Textarea
            id="lore-text"
            rows={18}
            className="font-mono text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            保存世界书
          </Button>
          {name ? (
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRemoving(true)}>
              删除
            </Button>
          ) : null}
        </div>
      </form>
    </div>
    <ConfirmDialog
        open={removing}
        title="删除世界书？"
        description={name ? `「${name}」会从工作区里拿掉。` : ""}
        busy={busy}
        onOpenChange={setRemoving}
        onConfirm={() => {
          if (!name) return;
          setBusy(true);
          void api
            .deleteLorebook(worldId, name)
            .then(() => {
              setRemoving(false);
              setCreatingNew(false);
              setName("");
              setText("");
              return onReload();
            })
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}
