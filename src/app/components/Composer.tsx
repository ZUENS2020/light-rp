import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/field";
import { Textarea } from "./ui/field";
import { SYSTEM_COMMANDS } from "../../core/commands";

type Props = {
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
};

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = disabled || sending;
  const commandQuery = text.trim().startsWith("/") ? text.trim().slice(1).toLowerCase() : "";
  const commandMatches = commandQuery
    ? SYSTEM_COMMANDS.filter((command) => command.name.startsWith(commandQuery.split(/\s/, 1)[0])).slice(0, 5)
    : [];

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
      className="bg-background/95 border-t border-border p-4 backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mx-auto flex max-w-[42rem] flex-col gap-3">
        <Label htmlFor="turn">你的行动</Label>
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
        {commandMatches.length ? (
          <div className="border border-border bg-surface p-1" aria-label="系统命令建议">
            {commandMatches.map((command) => (
              <button
                key={command.name}
                type="button"
                className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left font-ui text-xs hover:bg-muted"
                onClick={() => setText(command.name === "ooc" ? "/ooc " : command.usage)}
              >
                <span className="font-mono text-foreground">{command.usage}</span>
                <span className="truncate text-secondary">{command.description}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p className="font-ui text-xs text-secondary">Enter 发送 · Shift+Enter 换行 · /help 命令</p>
          <Button type="submit" disabled={busy || !text.trim()} aria-busy={sending}>
            {sending ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {sending ? "生成中" : "发送"}
          </Button>
        </div>
      </div>
    </form>
  );
}
