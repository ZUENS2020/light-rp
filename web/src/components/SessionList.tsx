import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import type { SessionInfo } from "../lib/api";
import { formatWhen } from "../lib/time";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input, Label } from "./ui/field";
import { cn } from "../lib/utils";

export function SessionList({
  worldId,
  sessions,
  activeId,
  onCreate,
  onRename,
  onDelete,
  creating = false,
  compact = false,
}: {
  worldId: string;
  sessions: SessionInfo[];
  activeId?: string;
  onCreate: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  creating?: boolean;
  compact?: boolean;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<SessionInfo | null>(null);
  const [title, setTitle] = useState("");
  const [removing, setRemoving] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const filtered = sessions.filter((item) => {
    const hay = `${item.title} ${item.preview} ${item.id}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 p-3">
        <Button type="button" className="flex-1" disabled={creating} onClick={onCreate}>
          <Plus className="h-4 w-4" aria-hidden />
          新会话
        </Button>
      </div>
      <div className="px-3 pb-2">
        <Label htmlFor={searchId} className="sr-only">
          搜索会话
        </Label>
        <Input
          id={searchId}
          value={query}
          placeholder="搜索会话"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {filtered.length === 0 ? (
          <li className="px-3 py-8 font-ui text-sm text-secondary">
            {sessions.length ? "没有匹配的会话。" : "还没有会话。"}
          </li>
        ) : (
          filtered.map((item) => {
            const active = item.id === activeId;
            return (
              <li key={item.id}>
                <div
                  className={cn(
                    "group flex items-start gap-1 rounded-lg px-1 py-1 transition-colors duration-200",
                    active ? "bg-muted" : "hover:bg-muted/70",
                  )}
                >
                  <Link
                    to={`/w/${worldId}/s/${item.id}`}
                    className="min-w-0 flex-1 rounded-md px-2 py-2"
                    aria-current={active ? "page" : undefined}
                  >
                    <p className="flex items-center gap-2 font-ui text-sm font-medium">
                      <MessageSquare className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
                      <span className="truncate">{item.title || "新会话"}</span>
                    </p>
                    {compact ? null : (
                      <p className="mt-1 truncate pl-6 font-ui text-xs text-secondary">
                        {item.preview || "空白对局"}
                      </p>
                    )}
                    <p className="mt-1 pl-6 font-ui text-xs text-secondary">
                      {formatWhen(item.updated)}
                      {item.messages ? ` · ${item.messages} 条` : ""}
                    </p>
                  </Link>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-1 h-11 w-11 shrink-0 opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                    aria-label={`重命名 ${item.title || item.id}`}
                    onClick={() => {
                      setRenaming(item);
                      setTitle(item.title || "");
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-1 h-11 w-11 shrink-0 text-destructive opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                    aria-label={`删除 ${item.title || item.id}`}
                    onClick={() => setRemoving(item)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })
        )}
      </ul>

      <Dialog open={Boolean(renaming)} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogTitle>重命名会话</DialogTitle>
          <DialogDescription>只改显示名称，对局记录还在。</DialogDescription>
          <form
            className="mt-6 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!renaming || !title.trim()) return;
              setBusy(true);
              void onRename(renaming.id, title.trim())
                .then(() => setRenaming(null))
                .finally(() => setBusy(false));
            }}
          >
            <Label htmlFor="rename-session">名称</Label>
            <Input id="rename-session" value={title} onChange={(event) => setTitle(event.target.value)} />
            <Button type="submit" disabled={busy || !title.trim()}>
              保存
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        title="删除会话？"
        description={removing ? `「${removing.title || removing.id}」会从工作区里拿掉，不能恢复。` : ""}
        busy={busy}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={() => {
          if (!removing) return;
          setBusy(true);
          void onDelete(removing.id)
            .then(() => setRemoving(null))
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
