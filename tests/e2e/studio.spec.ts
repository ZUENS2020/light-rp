import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_SETTINGS } from "../../src/server/settings";

const model = {
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
};

const play = {
  world: {
    id: "world-1",
    name: "铜灯街",
    path: "v2/workspaces/world-1",
    nmem_space: null,
    player_name: "你",
    primary: "mei",
    latest_session: "session-1",
    cast: [{ id: "mei", name: "梅", blurb: "钟表匠", present: true, aliases: [] }],
    sessions: [
      {
        id: "session-1",
        title: "雨夜",
        messages: 2,
        nmem_space: null,
        updated: "2026-08-30T00:00:00Z",
        preview: "门铃轻响",
      },
    ],
  },
  session_id: "session-1",
  session_title: "雨夜",
  primary_character: "mei",
  nmem_space: null,
  nmem_available: true,
  warnings: [],
  opening: "",
  scene: { location: "钟表铺", time: "深夜", weather: "雨", present: ["mei"], scene: "铜灯微亮", notes: "" },
  memory: "门外仍在下雨",
  player: "玩家设定",
  player_memory: "",
  messages: [
    { role: "user", content: "推开门", ts: "2026-08-30T00:00:00Z" },
    { role: "assistant", content: "门铃轻响。", ts: "2026-08-30T00:00:01Z" },
  ],
  context_report: {
    max_tokens: 32_000,
    generation_reserve: 4_096,
    total: 8_000,
    sections: [{ name: "stable", tokens: 5_000, budget: 8_000, truncated: false }],
    history: { tokens: 2_000, messages: 2, truncated: false },
    input: { tokens: 50 },
  },
};

async function mockApi(page: Page, state = play) {
  await page.route("**/api/v2/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = {};
    if (path === "/api/v2/play/world-1/session-1") body = state;
    else if (path === "/api/v2/models") body = { models: [model] };
    else if (path === "/api/v2/sessions/session-1/model") body = { model, prompt_epoch: 3, affinity_key: "lrp-a" };
    else if (path === "/api/v2/sessions/session-1/memory") {
      body = {
        core: { world: 1, player: 1, character: 1 },
        recall: { space_id: "rp-mem", recalled_count: 2, created_at: "2026-08-30T00:00:00Z" },
        sync: {
          status: "completed",
          space_id: "rp-mem",
          core_memory_count: 3,
          error: null,
          updated_at: "2026-08-30T00:00:00Z",
        },
      };
    } else if (path === "/api/v2/sessions/session-1/cache") {
      body = {
        model,
        prompt_epoch: 3,
        stable_prefix_tokens: 5_000,
        volatile_tokens: 1_200,
        output_contract_tokens: 64,
        prompt_tokens: 8_000,
        cached_input_tokens: 5_200,
        prefix_cache_ratio: 0.65,
        response_cache_status: "HIT",
      };
    } else if (path === "/api/v2/sessions/session-1/tasks/active") body = { task: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

test("IME confirmation, cancellation, drafts and reload use the V2 task lifecycle", async ({ page }) => {
  const state = structuredClone(play);
  await mockApi(page, state);
  let status = "running";
  let submissions = 0;
  let stops = 0;
  const task = () => ({ id: "task-test", status });
  await page.route("**/api/v2/sessions/session-1/turn", async (route) => {
    submissions++;
    const { text } = route.request().postDataJSON();
    state.messages.push({ role: "user", content: text, ts: new Date().toISOString() });
    await route.fulfill({ json: { task_id: "task-test", status: "pending" }, status: 202 });
  });
  await page.route("**/api/v2/tasks/task-test", (route) => route.fulfill({ json: task() }));
  await page.route("**/api/v2/tasks/task-test/cancel", async (route) => {
    stops++;
    status = "cancelled";
    await route.fulfill({ json: task() });
  });
  await page.goto("/w/world-1/s/session-1");
  const input = page.getByLabel("你的行动");
  await input.fill("确认输入");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(input).toHaveValue("确认输入");
  expect(submissions).toBe(0);
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  await input.fill("下一条草稿");
  await input.press("Enter");
  expect(submissions).toBe(1);
  await page.getByRole("button", { name: "停止生成" }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  expect(stops).toBe(1);
  await expect(input).toHaveValue("下一条草稿");
  await expect(page.getByRole("button", { name: /编辑/ })).toHaveCount(0);
  await page.reload();
  await expect(input).toHaveValue("下一条草稿");
  await expect(page.getByText("确认输入", { exact: true })).toBeVisible();
});

test("committing is visible and cannot misleadingly offer stop", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/v2/sessions/session-1/tasks/active", (route) =>
    route.fulfill({ json: { task: { id: "saving", status: "committing" } } }),
  );
  await page.route("**/api/v2/tasks/saving", (route) =>
    route.fulfill({ json: { id: "saving", status: "committing" } }),
  );
  await page.goto("/w/world-1/s/session-1");
  await expect(page.getByRole("button", { name: "正在保存" })).toBeDisabled();
  await expect(page.getByLabel("你的行动")).toBeEnabled();
});

test("reading earlier history does not jump when a task arrives and the inspector stays fixed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = structuredClone(play);
  state.messages = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `第 ${index} 条记录。\n${"窗外的雨落在街沿，门铃轻响。".repeat(12)}`,
    ts: `2026-08-30T00:00:${String(index).padStart(2, "0")}Z`,
  }));
  await mockApi(page, state);
  await page.goto("/w/world-1/s/session-1");
  const inspector = page.locator('section[aria-label="上下文检查器"]:visible');
  await expect(inspector).toBeVisible();
  const before = await inspector.boundingBox();
  const transcript = page.locator("#transcript");
  await transcript.evaluate((element) => {
    element.parentElement!.scrollTop = 200;
  });
  await expect(page.getByRole("button", { name: "回到底部" })).toBeVisible();
  await page.route("**/api/v2/sessions/session-1/turn", (route) =>
    route.fulfill({ json: { task_id: "scroll-task", status: "pending" }, status: 202 }),
  );
  await page.route("**/api/v2/tasks/scroll-task", (route) =>
    route.fulfill({ json: { id: "scroll-task", status: "running" } }),
  );
  await page.getByLabel("你的行动").fill("新的一轮");
  await page.getByLabel("你的行动").press("Enter");
  await expect(page.getByRole("button", { name: "停止生成" })).toBeVisible();
  expect(await transcript.evaluate((element) => element.parentElement!.scrollTop)).toBe(200);
  expect((await inspector.boundingBox())?.y).toBe(before?.y);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole("button", { name: "回到底部" }).click();
  await expect(page.getByText("新的一轮", { exact: true })).toBeVisible();
});

test("nmem only connects on the explicit settings action, with no automatic probe", async ({ page }) => {
  await mockApi(page);
  let status = "offline";
  let probes = 0;
  await page.route("**/api/v2/settings", (route) =>
    route.fulfill({
      json: {
        ...structuredClone(DEFAULT_SETTINGS),
        llm: {
          ...DEFAULT_SETTINGS.llm,
          default_model_config_id: model.id,
          gateway_id: "sillytavern",
          gateway_binding: true,
        },
      },
    }),
  );
  await page.route("**/api/v2/nmem/status", (route) => route.fulfill({ json: { status, revision: 1, pending: 2 } }));
  await page.route("**/api/v2/nmem/connect", async (route) => {
    probes++;
    status = "online";
    await route.fulfill({ json: { status, revision: 2, pending: 2 } });
  });
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "上线", exact: true })).toBeVisible();
  expect(probes).toBe(0);
  await page.getByRole("button", { name: "上线", exact: true }).click();
  await expect(page.getByRole("button", { name: "下线", exact: true })).toBeVisible();
  expect(probes).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "下线", exact: true })).toBeVisible();
  expect(probes).toBe(1);
});

for (const width of [375, 768, 1024, 1440]) {
  test(`Studio responds correctly at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApi(page);
    await page.goto("/w/world-1/s/session-1");

    await expect(page.getByRole("heading", { name: "铜灯街" })).toBeVisible();
    expect(
      await page
        .getByRole("heading", { name: "铜灯街" })
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await expect(page.getByText("门铃轻响。")).toBeVisible();
    await expect(page.getByLabel("你的行动")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`studio-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    if (width >= 768) {
      await expect(page.getByRole("combobox", { name: "选择下一条消息使用的模型" })).toBeVisible();
    } else {
      await expect(page.getByRole("combobox", { name: "选择下一条消息使用的模型" })).toBeHidden();
    }

    if (width >= 1280) {
      const inspector = page.locator('section[aria-label="上下文检查器"]:visible');
      const before = await inspector.boundingBox();
      await page.locator("#transcript").evaluate((element) => {
        if (element.parentElement) element.parentElement.scrollTop = 500;
      });
      const after = await inspector.boundingBox();
      expect(Math.round(after?.y || 0)).toBe(Math.round(before?.y || 0));
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.getByRole("button", { name: "缓存" }).click();
      await expect(page.getByText("65%")).toBeVisible();
      await expect(page.getByRole("button", { name: "打开上下文检查器" })).toBeHidden();
    } else {
      await page.getByRole("button", { name: "打开上下文检查器" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "缓存" }).click();
      await expect(page.getByText("65%")).toBeVisible();
      if (width < 768) {
        await expect(page.getByRole("combobox", { name: "移动端选择下一条消息使用的模型" })).toBeVisible();
      }
    }
  });
}
