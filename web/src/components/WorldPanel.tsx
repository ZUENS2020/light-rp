import { useEffect, useId, useState } from "react";
import type { PlayState } from "../lib/api";
import { Button } from "./ui/button";
import { Hint, Label, Textarea } from "./ui/field";

export function WorldPanel({
  state,
  onSaveMemory,
  disabled,
}: {
  state: PlayState;
  onSaveMemory?: (body: { world: string; player: string }) => Promise<void>;
  disabled?: boolean;
}) {
  const scene = state.scene;
  const presentIds = new Set(scene.present.map((id) => id.toLowerCase()));
  const presentMembers = state.world.cast.filter((member) =>
    [member.id, member.name, ...member.aliases].some((name) => name && presentIds.has(name.toLowerCase())),
  );
  const body = scene.scene || scene.notes;
  const worldMemId = useId();
  const playerMemId = useId();
  const [worldMemory, setWorldMemory] = useState(state.memory);
  const [playerMemory, setPlayerMemory] = useState(state.player_memory || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWorldMemory(state.memory);
    setPlayerMemory(state.player_memory || "");
  }, [state.memory, state.player_memory]);

  async function saveMemory() {
    if (!onSaveMemory || disabled || saving) return;
    setSaving(true);
    try {
      await onSaveMemory({ world: worldMemory, player: playerMemory });
    } finally {
      setSaving(false);
    }
  }

  const locked = Boolean(disabled) || saving;

  return (
    <div className="space-y-6 font-ui text-sm">
      <section className="space-y-3">
        <h2 className="font-display text-base font-semibold">当前场面</h2>
        <dl className="space-y-3">
          <div>
            <dt className="text-secondary">时间</dt>
            <dd>{[scene.time, scene.season].filter(Boolean).join(" · ") || "—"}</dd>
          </div>
          <div>
            <dt className="text-secondary">天气</dt>
            <dd>{scene.weather || "—"}</dd>
          </div>
          <div>
            <dt className="text-secondary">地点</dt>
            <dd>{scene.location || "—"}</dd>
          </div>
          <div>
            <dt className="text-secondary">场面</dt>
            <dd className="whitespace-pre-wrap font-body">{body || "—"}</dd>
          </div>
          {scene.ongoing && scene.ongoing.length ? (
            <div>
              <dt className="text-secondary">进行中</dt>
              <dd>{scene.ongoing.join("；")}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-base font-semibold">在场</h2>
        {presentMembers.length === 0 ? (
          <p className="text-secondary">（无人在场）</p>
        ) : (
          <ul className="space-y-2">
            {presentMembers.map((member) => (
              <li key={member.id}>
                <p className="font-medium">{member.name}</p>
                {member.blurb ? <p className="text-secondary">{member.blurb}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="font-display text-base font-semibold">记忆</h2>
        <div className="space-y-2">
          <Label htmlFor={worldMemId}>世界记忆</Label>
          <Textarea
            id={worldMemId}
            rows={6}
            value={worldMemory}
            disabled={locked}
            onChange={(event) => setWorldMemory(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={playerMemId}>玩家记忆</Label>
          <Textarea
            id={playerMemId}
            rows={4}
            value={playerMemory}
            disabled={locked}
            onChange={(event) => setPlayerMemory(event.target.value)}
          />
        </div>
        <Hint>多条记忆用 § 分隔。这里改 MEMORY.md 与 PLAYER_MEMORY.md，不会改 PLAYER.md。</Hint>
        <Button type="button" disabled={locked || !onSaveMemory} onClick={() => void saveMemory()}>
          保存记忆
        </Button>
      </section>
    </div>
  );
}
