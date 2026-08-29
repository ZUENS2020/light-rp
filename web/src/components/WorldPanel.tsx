import type { PlayState } from "../lib/api";

export function WorldPanel({ state }: { state: PlayState }) {
  const scene = state.scene;
  const presentIds = new Set(scene.present.map((id) => id.toLowerCase()));
  const presentMembers = state.world.cast.filter((member) =>
    [member.id, member.name, ...member.aliases].some((name) => name && presentIds.has(name.toLowerCase())),
  );
  const body = scene.scene || scene.notes;
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
    </div>
  );
}
