import { afterEach, describe, expect, it, vi } from "vitest";
import { listNmemSpaces, searchNmem, syncThreadTurn } from "../../src/adapters/nmem";
import { NmemOfflineError } from "../../src/adapters/nmem-connection";

const env = { NMEM_API_URL: "https://nmem.invalid", NMEM_API_KEY: "test" };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("nmem bounded requests", () => {
  it.each([401, 403, 408, 429, 502, 503, 504])("does not retry HTTP %s or broaden search filters", async (status) => {
    const fetcher = vi.fn(async () => new Response("", { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(searchNmem(env, "rp-mem", "约定")).rejects.toBeInstanceOf(NmemOfflineError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not retry an unreachable server", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await listNmemSpaces(env)).available).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("aborts a response body that stalls after headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    vi.stubGlobal("fetch", fetcher);
    const result = listNmemSpaces({ ...env, nmemDeadline: Date.now() + 1500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toMatchObject({ available: false });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("only retries a 422 compatibility response, within the same deadline", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 422 }))
      .mockResolvedValueOnce(Response.json({ memories: [] }));
    vi.stubGlobal("fetch", fetcher);
    expect(await searchNmem(env, "rp-mem", "约定")).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("preserves thread-create conflict handling and append deduplication", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await syncThreadTurn(env, "rp-mem", null, "thread", "title", [{ role: "user", content: "hello" }], "task");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ deduplicate: true, idempotency_key: "task" });
  });
});
