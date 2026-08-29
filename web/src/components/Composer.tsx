import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { CastMember } from "../lib/api";
import { Button } from "./ui/button";
import { Label } from "./ui/field";
import { Textarea } from "./ui/field";

type Props = {
  cast: CastMember[];
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
};

export function Composer({ cast, disabled, onSend }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = disabled || sending;

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setSending(true);
    setText("");
    try {
      await onSend(value);
    } catch {
      // PlayPage already surfaces the error; restore the draft.
      setText(value);
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="border-t border-border bg-background/95 p-4 backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mx-auto flex max-w-[42rem] flex-col gap-3">
        <Label htmlFor="turn">你的行动</Label>
        {cast.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {cast.map((member) => (
              <Button
                key={member.id}
                type="button"
                variant="ghost"
                className="min-h-11 px-3 text-xs"
                disabled={busy}
                onClick={() => setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${member.name} `)}
              >
                @{member.name}
              </Button>
            ))}
          </div>
        ) : null}
        <Textarea
          id="turn"
          name="turn"
          rows={3}
          value={text}
          disabled={busy}
          placeholder="写下这一轮。Enter 发送，Shift+Enter 换行。"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="font-ui text-xs text-secondary">Enter 发送 · Shift+Enter 换行</p>
          <Button type="submit" disabled={busy || !text.trim()} aria-busy={sending}>
            {sending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {sending ? "生成中" : "发送"}
          </Button>
        </div>
      </div>
    </form>
  );
}
