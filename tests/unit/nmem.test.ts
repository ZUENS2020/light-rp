import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSpaceId,
  searchNmem,
  syncMemorySnapshotToNmem,
  syncThreadTurn,
  syncTurnBodyToNmem,
} from "../../src/adapters/nmem";
import { shouldRecallMemory } from "../../src/core/memory";

const env = { NMEM_API_URL: "https://nmem.example/remote-api", NMEM_API_KEY: "test-key" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("nmem adapter", () => {
  it("defaults blank selections to the RP-mem space", () => {
    const spaces = [{ id: "rp-mem", key: "rp-mem", name: "RP mem" }];
    expect(resolveSpaceId(null, spaces)).toBe("rp-mem");
    expect(resolveSpaceId("RP mem", spaces)).toBe("rp-mem");
  });

  it("skips provider recall for acknowledgements without semantic signal", () => {
    expect(shouldRecallMemory("嗯")).toBe(false);
    expect(shouldRecallMemory("继续")).toBe(false);
    expect(shouldRecallMemory("她还记得港口的约定吗？")).toBe(true);
  });

  it("scopes recall to Light RP and the current world", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        space_id: "rp-mem",
        filter_labels: ["light-rp", "world:uma"],
      });
      return Response.json({ memories: [{ content: "只属于当前世界" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await searchNmem(env, "rp-mem", "关系", 8, ["light-rp", "world:uma"]);

    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("mirrors bounded core memory and forgets removed remote entries", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        requests.push({ url, method: init?.method || "GET", body });
        if (url.endsWith("/memories")) return Response.json({ memory: { id: body.id } });
        return Response.json({ ok: true });
      }),
    );

    const result = await syncMemorySnapshotToNmem(
      env,
      "rp-mem",
      { world: ["existing-world", "removed-world"] },
      "uma",
      {
        world: ["更新后的世界事实"],
        player: ["玩家偏好简洁回应"],
        characters: { teio: ["帝王记得约定"] },
      },
    );

    expect(result.count).toBe(3);
    expect(requests.some((request) => request.url.endsWith("/memories/removed-world/forget"))).toBe(true);
    expect(requests.filter((request) => request.url.endsWith("/memories"))).toHaveLength(2);
    expect(result.index.player?.[0]).toMatch(/^lightrp-fact-/);
    expect(result.index["character:teio"]?.[0]).toMatch(/^lightrp-fact-/);
  });

  it("uses task-level idempotency for turn memories and thread appends", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        requests.push({ url, body });
        if (url.endsWith("/memories")) return Response.json({ memory: { id: body.id } });
        return Response.json({ ok: true });
      }),
    );

    const memoryId = await syncTurnBodyToNmem(env, "rp-mem", "uma", "session-1", "你好", "欢迎", "task-1");
    await syncThreadTurn(
      env,
      "rp-mem",
      "thread-1",
      "thread-1",
      "Light RP / uma / session-1",
      [{ role: "user", content: "你好" }],
      "task-1",
    );

    expect(memoryId).toBe("lightrp-turn-task-1");
    expect(requests[0].body).toMatchObject({ id: "lightrp-turn-task-1", space_id: "rp-mem" });
    expect(requests[1].body).toMatchObject({ deduplicate: true, idempotency_key: "task-1" });
  });
});
