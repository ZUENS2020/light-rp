import worldYaml from "../../src/lightrp/data/example/world.yaml?raw";
import castYaml from "../../src/lightrp/data/example/cast.yaml?raw";
import worldMd from "../../src/lightrp/data/example/WORLD.md?raw";
import playerMd from "../../src/lightrp/data/example/PLAYER.md?raw";
import memoryMd from "../../src/lightrp/data/example/MEMORY.md?raw";
import sceneMd from "../../src/lightrp/data/example/SCENE.md?raw";
import anlan from "../../src/lightrp/data/example/characters/anlan.yaml?raw";
import xiaowu from "../../src/lightrp/data/example/characters/xiaowu.yaml?raw";
import harbor from "../../src/lightrp/data/example/lorebooks/harbor.json?raw";
import { workspaceFs } from "./r2";
import { stringifyYaml, workspaceIdOk } from "./util";

export async function seedLampHarbor(bucket: R2Bucket): Promise<void> {
  const fs = workspaceFs(bucket, "lamp-harbor");
  const files: Record<string, string> = {
    "world.yaml": worldYaml,
    "cast.yaml": castYaml,
    "WORLD.md": worldMd,
    "PLAYER.md": playerMd,
    "MEMORY.md": memoryMd,
    "SCENE.md": sceneMd,
    "characters/anlan.yaml": anlan,
    "characters/xiaowu.yaml": xiaowu,
    "lorebooks/harbor.json": harbor,
  };
  for (const [path, text] of Object.entries(files)) {
    if (!(await fs.get(path))) await fs.put(path, text);
  }
}

export async function createWorkspace(
  bucket: R2Bucket,
  id: string,
  name: string,
  playerName = "你",
): Promise<void> {
  if (!workspaceIdOk(id)) throw new Error("工作区 id 只能用小写字母、数字和连字符");
  const fs = workspaceFs(bucket, id);
  if (await fs.get("world.yaml")) throw new Error("工作区已存在");
  await fs.put("world.yaml", stringifyYaml({ id, name, primary: null, nmem_space: null, lore_token_budget: 1024, lore_scan_depth: 4 }));
  await fs.put("cast.yaml", stringifyYaml({ player_name: playerName, characters: [] }));
  await fs.put("WORLD.md", `# ${name}\n\n`);
  await fs.put("PLAYER.md", "");
  await fs.put("MEMORY.md", "");
  await fs.put("SCENE.md", "time: \nseason: \nweather: \nlocation: \npresent: []\nscene: |\n  \nongoing: []\n");
}
