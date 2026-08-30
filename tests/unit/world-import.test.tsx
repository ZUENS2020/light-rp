import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type WorldSummary } from "../../src/app/lib/api";
import { WorldPane } from "../../src/app/pages/workspace/WorldPane";

const world: WorldSummary = {
  id: "world-1",
  name: "铜灯街",
  path: "v2/workspaces/world-1",
  nmem_space: null,
  player_name: "你",
  primary: null,
  latest_session: null,
  cast: [],
  sessions: [],
  world_text: "",
  player_text: "",
};

afterEach(() => vi.restoreAllMocks());

describe("SillyTavern import", () => {
  it("uploads JSON cards through the V2 import API and reports imported assets", async () => {
    vi.spyOn(api, "spaces").mockResolvedValue({ available: true, spaces: [] });
    vi.spyOn(api, "importFiles").mockResolvedValue({
      ...world,
      imported: { cards: ["mei"], lorebooks: [], warnings: [] },
    });
    const onReload = vi.fn(async () => undefined);
    const { container } = render(<WorldPane world={world} onWorld={vi.fn()} onReload={onReload} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const file = new File(['{"name":"梅","description":"钟表匠"}'], "mei.json", { type: "application/json" });
    await userEvent.upload(input!, file);

    await waitFor(() =>
      expect(api.importFiles).toHaveBeenCalledWith("world-1", [
        { name: "mei.json", text: '{"name":"梅","description":"钟表匠"}' },
      ]),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("已导入：角色卡 mei");
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
