import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button } from "../../components/ui/button";
import { Checkbox, Hint, Input, Label, Textarea } from "../../components/ui/field";
import { api, type CharacterCard, type MiniCard } from "../../lib/api";
import { cn } from "../../lib/utils";

const EMPTY: CharacterCard = {
  id: "",
  name: "",
  age: "",
  description: "",
  personality: "",
  behavior: "",
  speech: "",
  likes: "",
  dislikes: "",
  backstory: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  system_prompt: "",
  tags: [],
  character_book: null,
  post_history_instructions: "",
  alternate_greetings: [],
};

const EMPTY_MINI: MiniCard = { id: "", name: "", summary: "", behavior_notes: "", relations: "" };

type Row = {
  member: { id: string; name: string; blurb: string; present: boolean; aliases: string[] };
  card: CharacterCard | null;
  mini: MiniCard | null;
};

const FIELDS = [
  ["description", "外貌"],
  ["personality", "性格"],
  ["behavior", "行为"],
  ["speech", "说话"],
  ["likes", "喜好"],
  ["dislikes", "厌恶"],
  ["backstory", "背景"],
  ["scenario", "场景"],
  ["first_mes", "开场白"],
  ["mes_example", "示例"],
  ["system_prompt", "角色规则"],
  ["post_history_instructions", "历史后指令"],
] as const;

export function CardsPane({ worldId, cards, onReload }: { worldId: string; cards: Row[]; onReload: (focusId?: string) => Promise<void> }) {
  const [active, setActive] = useState(cards[0]?.member.id || "");
  const [draft, setDraft] = useState<CharacterCard>(EMPTY);
  const [mini, setMini] = useState<MiniCard>(EMPTY_MINI);
  const [blurb, setBlurb] = useState("");
  const [present, setPresent] = useState(true);
  const [aliases, setAliases] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    const row = cards.find((item) => item.member.id === active) || cards[0];
    if (row) pick(row);
    else pick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards]);

  function pick(row: Row | null) {
    if (!row) {
      setActive("");
      setDraft({ ...EMPTY });
      setMini({ ...EMPTY_MINI });
      setBlurb("");
      setPresent(true);
      setAliases("");
      return;
    }
    setActive(row.member.id);
    setDraft({ ...EMPTY, ...(row.card || {}), id: row.member.id, name: row.card?.name || row.member.name });
    setMini({
      ...EMPTY_MINI,
      ...(row.mini || {}),
      id: row.member.id,
      name: row.mini?.name || row.member.name,
    });
    setBlurb(row.member.blurb);
    setPresent(row.member.present);
    setAliases(row.member.aliases.join(", "));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const cid = (draft.id || draft.name).trim().toLowerCase().replace(/\s+/g, "-");
    if (!cid) return;
    setBusy(true);
    setError("");
    try {
      await api.saveCard(worldId, cid, {
        ...draft,
        id: cid,
        member: {
          name: draft.name || cid,
          blurb,
          present,
          aliases: aliases.split(/[,，]/).map((part) => part.trim()).filter(Boolean),
        },
      });
      await api.saveMini(worldId, cid, {
        id: cid,
        name: mini.name || draft.name || cid,
        summary: mini.summary,
        behavior_notes: mini.behavior_notes,
        relations: mini.relations,
      });
      await onReload(cid);
      setSaved("角色卡与 Mini 已保存。");
      setActive(cid);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!active) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.generateMini(worldId, active);
      setMini(result.mini);
      setSaved("已从完整卡生成 Mini。");
      await onReload(active);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成 Mini 失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border bg-surface p-2">
          {cards.length === 0 ? <p className="px-3 py-6 font-ui text-sm text-secondary">还没有角色卡。</p> : null}
          <ul>
            {cards.map((row) => (
              <li key={row.member.id}>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-11 w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left font-ui text-sm transition-colors duration-200",
                    active === row.member.id ? "bg-muted" : "hover:bg-muted/70",
                  )}
                  onClick={() => pick(row)}
                >
                  <span className="truncate">{row.member.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-secondary">
                    {row.mini ? "Mini" : "无 Mini"}
                    {row.member.present ? " · 在场" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Button type="button" variant="secondary" className="mt-2 w-full" onClick={() => pick(null)}>
            新角色
          </Button>
        </aside>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="card-id">id</Label>
              <Input id="card-id" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-name">名字</Label>
              <Input id="card-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-age">年龄</Label>
              <Input id="card-age" value={draft.age} onChange={(event) => setDraft({ ...draft, age: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-blurb">演员表简介</Label>
              <Input id="card-blurb" value={blurb} onChange={(event) => setBlurb(event.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="card-aliases">别名（逗号分隔，用于 @）</Label>
            <Input id="card-aliases" value={aliases} onChange={(event) => setAliases(event.target.value)} />
          </div>
          <Checkbox id="card-present" checked={present} onChange={setPresent}>
            开场在场
          </Checkbox>

          <section className="space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display text-base font-semibold">Mini 卡</h3>
              {active ? (
                <Button type="button" variant="secondary" disabled={busy} onClick={() => void generate()}>
                  生成 Mini
                </Button>
              ) : null}
            </div>
            <Hint>独立资产 `characters/&lt;id&gt;.mini.yaml`。组卡时读这里，不再每轮从完整卡截取。</Hint>
            <div className="space-y-2">
              <Label htmlFor="mini-summary">概要</Label>
              <Textarea id="mini-summary" rows={3} value={mini.summary} onChange={(event) => setMini({ ...mini, summary: event.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mini-behavior">行为</Label>
              <Textarea
                id="mini-behavior"
                rows={3}
                value={mini.behavior_notes}
                onChange={(event) => setMini({ ...mini, behavior_notes: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mini-relations">关系</Label>
              <Textarea id="mini-relations" rows={3} value={mini.relations} onChange={(event) => setMini({ ...mini, relations: event.target.value })} />
            </div>
          </section>

          {FIELDS.map(([key, label]) => (
            <div key={key} className="space-y-2">
              <Label htmlFor={`card-${key}`}>{label}</Label>
              <Textarea
                id={`card-${key}`}
                value={String(draft[key] || "")}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              保存角色卡
            </Button>
            {active ? (
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setRemoving(true)}>
                删除
              </Button>
            ) : null}
          </div>
        </form>
      </div>
      <ConfirmDialog
        open={removing}
        title="删除角色卡？"
        description={active ? `「${draft.name || active}」会从演员表和角色文件里拿掉。` : ""}
        busy={busy}
        onOpenChange={setRemoving}
        onConfirm={() => {
          if (!active) return;
          setBusy(true);
          void api
            .deleteCard(worldId, active)
            .then(() => onReload())
            .then(() => {
              setRemoving(false);
            })
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}
