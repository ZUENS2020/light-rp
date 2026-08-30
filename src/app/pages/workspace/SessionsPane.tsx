import { useEffect, useState } from "react";
import { SessionList } from "../../components/SessionList";
import { api, type SessionInfo, type WorldSummary } from "../../lib/api";

export function SessionsPane({
  world,
  creating,
  onCreate,
}: {
  world: WorldSummary;
  creating: boolean;
  onCreate: () => void;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>(world.sessions || []);
  const [error, setError] = useState("");

  useEffect(() => {
    setSessions(world.sessions || []);
  }, [world.sessions]);

  async function refresh() {
    const data = await api.sessions(world.id);
    setSessions(data.sessions);
  }

  return (
    <div className="rounded-xl border border-border bg-surface">
      {error ? (
        <p className="border-destructive/30 border-b px-4 py-3 font-ui text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex h-[min(70vh,40rem)] flex-col">
        <SessionList
          worldId={world.id}
          sessions={sessions}
          creating={creating}
          onCreate={onCreate}
          onRename={async (id, title) => {
            setError("");
            try {
              await api.renameSession(world.id, id, title);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "无法重命名");
              throw err;
            }
          }}
          onDelete={async (id) => {
            setError("");
            try {
              await api.deleteSession(world.id, id);
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "无法删除");
              throw err;
            }
          }}
        />
      </div>
    </div>
  );
}
