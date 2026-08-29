import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { Button } from "../components/ui/button";
import { api, type CharacterCard, type MiniCard, type WorldSummary } from "../lib/api";
import { CardsPane } from "./workspace/CardsPane";
import { LorePane } from "./workspace/LorePane";
import { SessionsPane } from "./workspace/SessionsPane";
import { WorldPane } from "./workspace/WorldPane";

function tabFromPath(pathname: string): "sessions" | "world" | "cards" | "lore" {
  if (pathname.endsWith("/world")) return "world";
  if (pathname.endsWith("/cards")) return "cards";
  if (pathname.endsWith("/lore")) return "lore";
  return "sessions";
}

export function WorkspacePage() {
  const { worldId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const tab = tabFromPath(location.pathname);
  const [world, setWorld] = useState<WorldSummary | null>(null);
  const [cards, setCards] = useState<
    { member: { id: string; name: string; blurb: string; present: boolean; aliases: string[] }; card: CharacterCard | null; mini: MiniCard | null }[]
  >([]);
  const [lorebooks, setLorebooks] = useState<{ name: string; text: string }[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  async function reload() {
    setError("");
    const [w, c, l] = await Promise.all([api.world(worldId), api.cards(worldId), api.lorebooks(worldId)]);
    setWorld(w);
    setCards(c.cards);
    setLorebooks(l.lorebooks);
  }

  useEffect(() => {
    reload().catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  async function createSession() {
    setCreating(true);
    setError("");
    try {
      const state = await api.open(worldId, { new: true, space: world?.nmem_space || null });
      navigate(`/w/${worldId}/s/${state.session_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法开局");
    } finally {
      setCreating(false);
    }
  }

  if (!world && !error) {
    return (
      <div className="flex min-h-dvh items-center justify-center font-ui text-secondary">
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden />
        读取工作区…
      </div>
    );
  }

  if (!world) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <p className="text-destructive" role="alert">
          {error}
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate("/")}>
          返回工作区列表
        </Button>
      </div>
    );
  }

  return (
    <WorkspaceShell worldId={worldId} name={world.name} creating={creating} onNewSession={() => void createSession()}>
      {error ? (
        <p className="mb-6 font-ui text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {tab === "sessions" ? <SessionsPane world={world} creating={creating} onCreate={() => void createSession()} /> : null}
      {tab === "world" ? <WorldPane world={world} onWorld={setWorld} onReload={reload} /> : null}
      {tab === "cards" ? <CardsPane worldId={worldId} cards={cards} onReload={() => reload()} /> : null}
      {tab === "lore" ? <LorePane worldId={worldId} lorebooks={lorebooks} onReload={() => reload()} /> : null}
    </WorkspaceShell>
  );
}
