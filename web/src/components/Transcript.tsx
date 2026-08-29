import { ChevronDown, CloudSun, LoaderCircle, MapPin, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlayState } from "../lib/api";

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

export function Transcript({ state, pending }: { state: PlayState; pending?: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.messages.length, state.opening, pending]);

  const visible = state.messages.filter((item) => item.role !== "system" || Boolean(item.content));
  const lastAssistant = [...visible].reverse().find((item) => item.role === "assistant");

  return (
    <div id="transcript" className="mx-auto flex w-full max-w-[42rem] flex-col gap-8 px-4 py-10">
      {state.opening ? (
        <article className="whitespace-pre-wrap font-body text-base leading-relaxed">{stripHidden(state.opening)}</article>
      ) : null}
      {visible.map((item, index) => {
        const text = stripHidden(item.content);
        if (!text && item.role !== "system") return null;
        if (item.role === "user") {
          return (
            <article key={`${item.ts}-${index}`} className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
              <p className="font-ui text-[0.65rem] uppercase tracking-wide text-secondary">你</p>
              <div className="whitespace-pre-wrap font-body text-base leading-relaxed">{text}</div>
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
            <div className="whitespace-pre-wrap font-body text-base leading-relaxed">{text}</div>
            {item === lastAssistant ? <StateBar state={state} /> : null}
          </article>
        );
      })}
      {!lastAssistant && (state.opening || visible.length === 0) ? <StateBar state={state} /> : null}
      {pending ? (
        <article className="flex items-center gap-2 font-ui text-sm text-secondary" aria-live="polite">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          正在生成…
        </article>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
