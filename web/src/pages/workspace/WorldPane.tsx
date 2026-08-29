import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Hint, Input, Label, Textarea } from "../../components/ui/field";
import { api, type WorldSummary } from "../../lib/api";

export function WorldPane({
  world,
  onWorld,
  onReload,
}: {
  world: WorldSummary;
  onWorld: (next: WorldSummary) => void;
  onReload: () => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(world.name);
  const [playerName, setPlayerName] = useState(world.player_name);
  const [nmemSpace, setNmemSpace] = useState(world.nmem_space || "");
  const [worldText, setWorldText] = useState(world.world_text || "");
  const [playerText, setPlayerText] = useState(world.player_text || "");
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    setName(world.name);
    setPlayerName(world.player_name);
    setNmemSpace(world.nmem_space || "");
    setWorldText(world.world_text || "");
    setPlayerText(world.player_text || "");
  }, [world]);

  useEffect(() => {
    void api
      .spaces()
      .then((data) => setSpaces(data.spaces))
      .catch(() => setSpaces([]));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await api.saveWorld(world.id, {
        name,
        player_name: playerName,
        nmem_space: nmemSpace.trim() || null,
        world_text: worldText,
        player_text: playerText,
      });
      onWorld(next);
      setSaved("世界包已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    setError("");
    try {
      const files = [];
      for (const file of Array.from(list)) {
        if (/\.png$/i.test(file.name)) {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          files.push({ name: file.webkitRelativePath || file.name, data: btoa(binary) });
        } else if (/\.(json|ya?ml)$/i.test(file.name)) {
          files.push({ name: file.webkitRelativePath || file.name, text: await file.text() });
        }
      }
      const result = await api.importFiles(world.id, files);
      await onReload();
      const imported = result.imported;
      const bits = [
        imported.cards.length ? `角色卡 ${imported.cards.join("、")}` : "",
        imported.lorebooks.length ? `世界书 ${imported.lorebooks.join("、")}` : "",
      ].filter(Boolean);
      setSaved(bits.length ? `已导入：${bits.join("；")}` : "没有识别到角色卡或世界书。");
      if (imported.warnings.length) setError(imported.warnings.join("；"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
      if (folderRef.current) folderRef.current.value = "";
    }
  }

  return (
    <form className="space-y-6" onSubmit={(event) => void save(event)}>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
          导入文件
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => folderRef.current?.click()}>
          导入文件夹
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          multiple
          accept=".json,.yaml,.yml,.png,application/json,image/png"
          onChange={(event) => void importFiles(event.target.files)}
        />
        <input
          ref={(node) => {
            folderRef.current = node;
            if (node) {
              node.setAttribute("webkitdirectory", "");
              node.setAttribute("directory", "");
            }
          }}
          type="file"
          className="hidden"
          multiple
          onChange={(event) => void importFiles(event.target.files)}
        />
        <Hint>SillyTavern 的 PNG/JSON 角色卡、世界书 JSON，或整个角色卡文件夹。</Hint>
      </div>
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
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="world-name">名称</Label>
          <Input id="world-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="player-name">玩家称呼</Label>
          <Input id="player-name" value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="world-nmem">默认 nmem 工作区</Label>
        <Input
          id="world-nmem"
          list="world-nmem-spaces"
          value={nmemSpace}
          placeholder="留空则新会话不同步 Mem"
          onChange={(event) => setNmemSpace(event.target.value)}
        />
        <datalist id="world-nmem-spaces">
          {spaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}（{item.id}）
            </option>
          ))}
        </datalist>
        <Hint>填 id，例如 rp-mem。未选不会写入 default。</Hint>
      </div>
      <div className="space-y-2">
        <Label htmlFor="world-text">WORLD.md</Label>
        <Textarea id="world-text" rows={12} value={worldText} onChange={(event) => setWorldText(event.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="player-text">PLAYER.md</Label>
        <Textarea id="player-text" rows={6} value={playerText} onChange={(event) => setPlayerText(event.target.value)} />
      </div>
      <Button type="submit" disabled={busy}>
        保存世界包
      </Button>
    </form>
  );
}
