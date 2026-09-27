import { ChevronDown, CloudSun, LoaderCircle, MapPin, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlayState } from "../lib/api";
import { Button } from "./ui/button";
import { Hint, Textarea } from "./ui/field";

function stripHidden(content: string): string {
  return content
    .replace(/<rp_state>[\s\S]*?<\/rp_state>/gi, "")
    .replace(/```lightrp[\s\S]*?```/gi, "")
    .trim();
}

function StateBar({ state }: { state: PlayState }) {
  const [open, setOpen] = useState(false);
  const scene = state.scene;
  const line = [scene.time, scene.season, scene.location].filter(Boolean).join(" · ") || "当前场景";
  const body = scene.scene || scene.notes;
  const presentNames = scene.present
    .map((id) => state.world.cast.find((member) => member.id === id || member.name === id)?.name || id)
    .join("、");

  return (
    <div className="border border-border bg-surface">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-ui text-xs text-secondary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{line}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open ? (
        <dl className="space-y-2 border-t border-border px-3 py-3 font-ui text-sm">
          {scene.weather ? (
            <div className="flex gap-2">
              <dt className="text-secondary">
                <CloudSun className="inline h-3.5 w-3.5" aria-hidden /> 天气
              </dt>
              <dd>{scene.weather}</dd>
            </div>
          ) : null}
          {presentNames ? (
            <div className="flex gap-2">
              <dt className="text-secondary">
                <Users className="inline h-3.5 w-3.5" aria-hidden /> 在场
              </dt>
              <dd>{presentNames}</dd>
            </div>
          ) : null}
          {body ? (
            <div>
              <dt className="text-secondary">场面</dt>
              <dd className="whitespace-pre-wrap font-body">{body}</dd>
            </div>
          ) : null}
          {scene.ongoing && scene.ongoing.length ? (
            <div>
              <dt className="text-secondary">进行中</dt>
              <dd>{scene.ongoing.join("；")}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function EditPanel({
  draft,
  saveLabel,
  onDraft,
  onCancel,
  onSave,
}: {
  draft: string;
  saveLabel: string;
  onDraft: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea value={draft} rows={4} onChange={(event) => onDraft(event.target.value)} />
      <Hint>会删掉这条后面的全部回复</Hint>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="button" disabled={!draft.trim()} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

export function Transcript({
  state,
  pending,
  streamingText,
  disabled,
  messageOffset = 0,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRewrite,
  scrollKey = "",
}: {
  state: PlayState;
  /** Chat identity (session id): the initial scroll-to-bottom runs once per key. */
  scrollKey?: string;
  pending?: boolean;
  /** Growing assistant text while a generation task is running. */
  streamingText?: string;
  disabled?: boolean;
  /** Absolute start index of `state.messages` in the full transcript. */
  messageOffset?: number;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  onRewrite?: (index: number, content: string) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  const scrolledKeyRef = useRef<string | null>(null);
  const hasContent = state.messages.length > 0 || Boolean(state.opening);

  // Exactly ONE jump to the bottom: the first time this chat's first page of history renders.
  // No auto-scroll while generating, on finalize, on refetch, on retry, or on "load older".
  useEffect(() => {
    if (!hasContent || scrolledKeyRef.current === scrollKey) return;
    scrolledKeyRef.current = scrollKey;
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [hasContent, scrollKey]);

  const lastAssistantIndex = (() => {
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const item = state.messages[i];
      if (item.role === "assistant" && stripHidden(item.content)) return i;
    }
    return -1;
  })();
  const canEditRole = (role: string) => role === "user" || role === "assistant";
  const showEdit = Boolean(onRewrite) && !pending && !disabled;

  function startEdit(index: number, content: string) {
    setEditingIndex(index);
    setDraft(content);
  }

  function saveEdit(localIndex: number) {
    const text = draft;
    setEditingIndex(null);
    onRewrite?.(messageOffset + localIndex, text);
  }

  return (
    <div id="transcript" className="mx-auto flex w-full max-w-[42rem] flex-col gap-8 px-4 py-10">
      {state.opening ? (
        <article className="whitespace-pre-wrap font-body text-base leading-relaxed">
          {stripHidden(state.opening)}
        </article>
      ) : null}
      {hasOlder && onLoadOlder ? (
        <div className="flex justify-center">
          <Button type="button" variant="secondary" disabled={loadingOlder || disabled} onClick={onLoadOlder}>
            {loadingOlder ? (
              <>
                <LoaderCircle className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                加载中…
              </>
            ) : (
              "加载更早"
            )}
          </Button>
        </div>
      ) : null}
      {state.messages.map((item, index) => {
        const text = stripHidden(item.content);
        if (item.role === "system" && !item.content) return null;
        if (item.role !== "system" && !text) return null;
        const editing = editingIndex === index;
        const editControl =
          showEdit && canEditRole(item.role) && !editing ? (
            <button
              type="button"
              className="font-ui text-[0.65rem] text-secondary hover:text-foreground"
              onClick={() => startEdit(index, item.content)}
            >
              编辑
            </button>
          ) : null;
        const editor = editing ? (
          <EditPanel
            draft={draft}
            saveLabel={item.role === "user" ? "保存并重写" : "保存"}
            onDraft={setDraft}
            onCancel={() => setEditingIndex(null)}
            onSave={() => saveEdit(index)}
          />
        ) : null;
        if (item.role === "user") {
          return (
            <article key={`${item.ts}-${index}`} className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <p className="font-ui text-[0.65rem] uppercase tracking-wide text-secondary">你</p>
                {editControl}
              </div>
              {editor || <div className="whitespace-pre-wrap font-body text-base leading-relaxed">{text}</div>}
            </article>
          );
        }
        if (item.role === "system") {
          return (
            <article key={`${item.ts}-${index}`} className="flex flex-col gap-2">
              <p className="font-ui text-xs uppercase tracking-wide text-secondary">摘要</p>
              <div className="whitespace-pre-wrap font-body text-sm leading-relaxed text-secondary">{text}</div>
            </article>
          );
        }
        return (
          <article key={`${item.ts}-${index}`} className="flex flex-col gap-3">
            {editControl}
            {editor || <div className="whitespace-pre-wrap font-body text-base leading-relaxed">{text}</div>}
            {index === lastAssistantIndex ? <StateBar state={state} /> : null}
          </article>
        );
      })}
      {lastAssistantIndex < 0 && (state.opening || state.messages.length === 0) ? <StateBar state={state} /> : null}
      {pending ? (
        <article className="flex flex-col gap-3" aria-live="polite" aria-busy="true">
          {streamingText?.trim() &&
          !(
            lastAssistantIndex >= 0 &&
            stripHidden(state.messages[lastAssistantIndex]?.content || "") === stripHidden(streamingText)
          ) ? (
            <div className="whitespace-pre-wrap font-body text-base leading-relaxed opacity-90">
              {stripHidden(streamingText)}
            </div>
          ) : null}
          {!(
            streamingText?.trim() &&
            lastAssistantIndex >= 0 &&
            stripHidden(state.messages[lastAssistantIndex]?.content || "") === stripHidden(streamingText)
          ) ? (
            <div className="flex items-center gap-2 font-ui text-sm text-secondary">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
              {streamingText?.trim() ? "生成中…" : "正在生成…"}
            </div>
          ) : null}
        </article>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
