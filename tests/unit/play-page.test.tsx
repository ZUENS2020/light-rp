import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type AiModelConfig, type PlayState } from "../../src/app/lib/api";
import { PlayPage } from "../../src/app/pages/PlayPage";

const models: AiModelConfig[] = [
  {
    id: "dsf0731-cheap-openrouter",
    label: "DSF0731 Cheap · OpenRouter",
    transport: "gateway",
    provider_slug: "openrouter",
    model_id: "@preset/dsf0731-cheap",
    context_window: 131_072,
    max_output_tokens: 8_192,
    supports_tools: true,
    supports_reasoning: true,
    enabled: true,
    sort_order: 10,
    revision: 1,
  },
  {
    id: "kimi-k2-6-workers",
    label: "Kimi K2.6",
    transport: "cloudflare",
    provider_slug: null,
    model_id: "@cf/moonshotai/kimi-k2.6",
    context_window: 262_144,
    max_output_tokens: 16_384,
    supports_tools: true,
    supports_reasoning: true,
    enabled: true,
    sort_order: 20,
    revision: 1,
  },
];

const playState: PlayState = {
  world: {
    id: "world-1",
    name: "铜灯街",
    path: "v2/workspaces/world-1",
    nmem_space: null,
    player_name: "你",
    latest_session: "session-1",
    cast: [{ id: "mei", name: "梅", blurb: "钟表匠", present: true, aliases: [] }],
    sessions: [
      {
        id: "session-1",
        title: "雨夜",
        messages: 1,
        nmem_space: null,
        updated: "2026-08-30T00:00:00Z",
        preview: "继续",
      },
    ],
  },
  session_id: "session-1",
  session_title: "雨夜",
  primary_character: "mei",
  nmem_space: null,
  warnings: [],
  opening: "",
  scene: { location: "钟表铺", time: "深夜", weather: "雨", present: ["mei"], scene: "铜灯微亮", notes: "" },
  memory: "门外仍在下雨",
  player: "玩家设定",
  player_memory: "",
  messages: [{ role: "assistant", content: "门铃轻响。", ts: "2026-08-30T00:00:00Z" }],
  context_report: {
    max_tokens: 32_000,
    generation_reserve: 4_096,
    total: 8_000,
    sections: [{ name: "stable", tokens: 5_000, budget: 8_000, truncated: false }],
    history: { tokens: 2_000, messages: 1, truncated: false },
    input: { tokens: 50 },
  },
};

function renderPlay() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/world-1/s/session-1"]}>
        <Routes>
          <Route path="/w/:worldId/s/:sessionId" element={<PlayPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubApi() {
  vi.spyOn(api, "play").mockResolvedValue(playState);
  vi.spyOn(api, "models").mockResolvedValue({ models });
  vi.spyOn(api, "sessionModel").mockResolvedValue({ model: models[0], prompt_epoch: 3, affinity_key: "lrp-a" });
  vi.spyOn(api, "setSessionModel").mockResolvedValue({ model: models[1], prompt_epoch: 4, affinity_key: "lrp-b" });
  vi.spyOn(api, "cache").mockResolvedValue({
    model: models[0],
    prompt_epoch: 3,
    stable_prefix_tokens: 5_000,
    volatile_tokens: 1_200,
    output_contract_tokens: 64,
    prompt_tokens: 8_000,
    cached_input_tokens: 5_200,
    prefix_cache_ratio: 0.65,
    response_cache_status: "HIT",
  });
  vi.spyOn(api, "memoryStatus").mockResolvedValue({
    core: { world: 1, player: 0, character: 0 },
    recall: null,
    sync: null,
  });
  vi.spyOn(api, "syncMemory").mockResolvedValue({
    ok: true,
    workspace_id: "world-1",
    space_id: null,
    core_memory_count: 1,
  });
  vi.spyOn(api, "activeTask").mockResolvedValue({ task: null });
  vi.spyOn(api, "turn").mockResolvedValue({ task_id: "task-1", status: "pending" });
  vi.spyOn(api, "regenerate").mockResolvedValue({ task_id: "task-regenerate", status: "pending" });
  vi.spyOn(api, "compact").mockResolvedValue(playState);
  vi.spyOn(api, "task").mockResolvedValue({ id: "task-1", status: "pending" });
}

afterEach(() => vi.restoreAllMocks());

describe("Play Studio", () => {
  it("keeps the composer free of the character mention shortcut bar", async () => {
    stubApi();
    renderPlay();

    await screen.findByLabelText("你的行动");
    expect(screen.queryByRole("button", { name: "@梅" })).not.toBeInTheDocument();
  });

  it("switches the runtime model for the next message and displays cache metrics", async () => {
    stubApi();
    const user = userEvent.setup();
    renderPlay();

    const selector = await screen.findByRole("combobox", { name: "选择下一条消息使用的模型" });
    await user.selectOptions(selector, "kimi-k2-6-workers");
    await waitFor(() => expect(api.setSessionModel).toHaveBeenCalledWith("session-1", "kimi-k2-6-workers"));

    await user.click(screen.getByRole("button", { name: "缓存" }));
    expect(await screen.findByText("65%")).toBeInTheDocument();
    expect(screen.getAllByText("5,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HIT").length).toBeGreaterThan(0);
  });

  it("submits a turn through the task API and locks model selection while pending", async () => {
    stubApi();
    const user = userEvent.setup();
    renderPlay();

    const editor = await screen.findByLabelText("你的行动");
    await user.type(editor, "推开门");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.turn).toHaveBeenCalledWith("session-1", "推开门", expect.any(String)));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择下一条消息使用的模型" })).toBeDisabled());
  });

  it("shows Hermes core memory status and D1 mirror sync", async () => {
    stubApi();
    const user = userEvent.setup();
    renderPlay();

    await user.click(await screen.findByRole("button", { name: "记忆" }));
    expect(await screen.findByText("Hermes memory")).toBeInTheDocument();
    expect(screen.getByText("R2 核心记忆 → D1 镜像")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新镜像核心记忆到 D1" }));
    await waitFor(() => expect(api.syncMemory).toHaveBeenCalledWith("world-1"));
  });

  it("executes local slash commands and sends OOC through the task API", async () => {
    stubApi();
    const user = userEvent.setup();
    renderPlay();

    const editor = await screen.findByLabelText("你的行动");
    await user.type(editor, "/help");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("region", { name: "系统命令" })).toBeInTheDocument();
    expect(api.turn).not.toHaveBeenCalled();

    await user.type(editor, "/ooc 解释当前关系");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.turn).toHaveBeenCalledWith("session-1", "/ooc 解释当前关系", expect.any(String)));
  });

  it("renders growing partial assistant text while the task is running", async () => {
    stubApi();
    vi.spyOn(api, "turn").mockResolvedValue({ task_id: "task-stream", status: "running" });
    vi.spyOn(api, "task").mockResolvedValue({
      id: "task-stream",
      status: "running",
      content: "门轴轻响，一缕夜风——",
    });
    const user = userEvent.setup();
    renderPlay();

    const editor = await screen.findByLabelText("你的行动");
    await user.type(editor, "推开门");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("门轴轻响，一缕夜风——")).toBeInTheDocument();
    expect(screen.getByText("生成中…")).toBeInTheDocument();
  });

  it("keeps streamed assistant text visible after the task completes (no withdraw flash)", async () => {
    stubApi();
    let taskStatus: "running" | "completed" = "running";
    vi.spyOn(api, "turn").mockResolvedValue({ task_id: "task-handoff", status: "running" });
    vi.spyOn(api, "task").mockImplementation(async () => ({
      id: "task-handoff",
      status: taskStatus,
      content: "门轴轻响，一缕夜风——",
    }));
    // After complete, play refetch should include the promoted assistant.
    vi.spyOn(api, "play").mockImplementation(async () => ({
      ...playState,
      messages: [
        ...playState.messages,
        { role: "user", content: "推开门", ts: "2026-08-30T00:01:00Z" },
        {
          role: "assistant",
          content: "门轴轻响，一缕夜风——",
          ts: "2026-08-30T00:01:01Z",
          task_id: "task-handoff",
        },
      ],
      message_window: { offset: 0, limit: 40, total: 3, has_older: false },
    }));
    const user = userEvent.setup();
    renderPlay();

    const editor = await screen.findByLabelText("你的行动");
    await user.type(editor, "推开门");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("门轴轻响，一缕夜风——")).toBeInTheDocument();

    taskStatus = "completed";
    await waitFor(() => {
      expect(screen.getByText("门轴轻响，一缕夜风——")).toBeInTheDocument();
    });
    expect(screen.queryByText("生成中…")).not.toBeInTheDocument();
  });

  it("scrolls to the bottom exactly once on entry — not on send, not on finalize", async () => {
    stubApi();
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scroll });
    let taskStatus: "running" | "completed" = "running";
    vi.spyOn(api, "turn").mockResolvedValue({ task_id: "task-scroll", status: "running" });
    vi.spyOn(api, "task").mockImplementation(async () => ({
      id: "task-scroll",
      status: taskStatus,
      content: "雨声更密了。",
    }));
    const user = userEvent.setup();
    renderPlay();

    const editor = await screen.findByLabelText("你的行动");
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
    await user.type(editor, "推开门");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("雨声更密了。")).toBeInTheDocument();
    taskStatus = "completed";
    await waitFor(() => expect(screen.queryByText("生成中…")).not.toBeInTheDocument(), { timeout: 8_000 });
    expect(scroll).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("finalizes from a runtime status snapshot and ignores a false WS failed frame", async () => {
    stubApi();
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
      emit(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    let taskStatus: "running" | "completed" = "running";
    vi.spyOn(api, "turn").mockResolvedValue({ task_id: "task-ws", status: "running" });
    const taskSpy = vi.spyOn(api, "task").mockImplementation(async () => ({
      id: "task-ws",
      status: taskStatus,
      content: taskStatus === "completed" ? "钟声停了。" : "",
    }));
    const user = userEvent.setup();
    renderPlay();

    const editor = await screen.findByLabelText("你的行动");
    await user.type(editor, "推开门");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(taskSpy).toHaveBeenCalled());

    // DO stale alarm says failed, D1 still running → no error banner.
    sockets[0].emit({ type: "failed", taskId: "task-ws", error: "生成超时未更新" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Reply lands while the completed frame is missed; a status snapshot (reconnect/ping) arrives.
    taskStatus = "completed";
    sockets[0].emit({ type: "status", taskId: "task-ws", status: "completed", partialContent: "钟声停了。" });
    await waitFor(() => expect(screen.getByText("钟声停了。")).toBeInTheDocument(), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.getAllByText("钟声停了。")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("finalizes as soon as the transcript holds the task's reply, even if the status poll lags", async () => {
    stubApi();
    vi.spyOn(api, "turn").mockResolvedValue({ task_id: "task-landed", status: "running" });
    // D1 status poll still says running (lagging) — never flips on its own in this test.
    vi.spyOn(api, "task").mockResolvedValue({ id: "task-landed", status: "running", content: "" });
    const landed: PlayState = {
      ...playState,
      messages: [
        ...playState.messages,
        { role: "user", content: "推开门", ts: "2026-08-30T00:01:00Z", task_id: "task-landed" },
        { role: "assistant", content: "檐下的铃停了。", ts: "2026-08-30T00:01:01Z", task_id: "task-landed" },
      ],
      message_window: { offset: 0, limit: 40, total: 3, has_older: false },
    };
    const user = userEvent.setup();
    const { container } = renderPlay();
    const editor = await screen.findByLabelText("你的行动");
    await user.type(editor, "推开门");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(screen.getByText("正在生成…")).toBeInTheDocument());

    // Reply arrives through a play refetch (e.g. reconnect/visibility resync).
    vi.spyOn(api, "play").mockResolvedValue(landed);
    await user.click(screen.getByRole("button", { name: "记忆" }));
    await user.click(screen.getByRole("button", { name: "重新镜像核心记忆到 D1" }));
    expect(await screen.findByText("檐下的铃停了。")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("正在生成…")).not.toBeInTheDocument());
    expect(screen.queryByText("生成中…")).not.toBeInTheDocument();
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
  });
});
