import { useEffect, useRef } from "react";
import type { PlayState } from "../lib/api";

export function Transcript({ state }: { state: PlayState }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.messages.length, state.opening]);

  const visible = state.messages.filter((item) => item.role !== "system" || Boolean(item.content));

  return (
    <div id="transcript" className="mx-auto flex w-full max-w-[42rem] flex-col gap-8 px-4 py-10">
      {state.opening ? (
        <article className="whitespace-pre-wrap font-body text-base leading-relaxed">{state.opening}</article>
      ) : null}
      {visible.map((item, index) => (
        <article key={`${item.ts}-${index}`} className="flex flex-col gap-2">
          <p className="font-ui text-xs uppercase tracking-wide text-secondary">
            {item.role === "user" ? "你" : item.role === "assistant" ? "世界" : "摘要"}
          </p>
          <div className="whitespace-pre-wrap font-body text-base leading-relaxed">{item.content}</div>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}
