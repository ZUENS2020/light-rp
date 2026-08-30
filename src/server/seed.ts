import { workspaceFs } from "../adapters/r2";
import { stringifyYaml, workspaceIdOk } from "../core/util";
import { DEFAULT_NMEM_SPACE_ID } from "../core/memory";

export async function createWorkspace(bucket: R2Bucket, id: string, name: string, playerName = "你"): Promise<void> {
  if (!workspaceIdOk(id)) throw new Error("工作区 id 只能用小写字母、数字和连字符");
  const fs = workspaceFs(bucket, id);
  if (await fs.get("world.yaml")) throw new Error("工作区已存在");
  const blankState = "time: \nseason: \nweather: \nlocation: \npresent: []\nscene: |\n  \nongoing: []\n";
  await fs.put(
    "world.yaml",
    stringifyYaml({
      id,
      name,
      primary: null,
      nmem_space: DEFAULT_NMEM_SPACE_ID,
      lore_token_budget: 1024,
      lore_scan_depth: 4,
    }),
  );
  await fs.put("cast.yaml", stringifyYaml({ player_name: playerName, characters: [] }));
  await fs.put("WORLD.md", `# ${name}\n\n`);
  await fs.put("PLAYER.md", "");
  await fs.put("PLAYER_MEMORY.md", "");
  await fs.put("MEMORY.md", "");
  await fs.put("INITIAL_STATE.yaml", blankState);
  await fs.put("SCENE.md", blankState);
}
