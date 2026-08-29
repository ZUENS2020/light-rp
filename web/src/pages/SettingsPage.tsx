import { LoaderCircle } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { Button } from "../components/ui/button";
import { Checkbox, Hint, Input, Label } from "../components/ui/field";
import { api, type AppSettings, type SettingsPut } from "../lib/api";

type FormState = Omit<SettingsPut, "llm"> & {
  llm: SettingsPut["llm"] & { api_key: string; clear_api_key: boolean };
};

function toForm(data: AppSettings): FormState {
  return {
    llm: {
      base_url: data.llm.base_url,
      model: data.llm.model,
      api_key: "",
      clear_api_key: false,
      api_key_env: data.llm.api_key_env,
      temperature: data.llm.temperature,
      max_tokens: data.llm.max_tokens,
      timeout: data.llm.timeout,
      breach: data.llm.breach !== false,
    },
    nmem: { ...data.nmem },
    memory: { ...data.memory },
    worlds_dir: data.worlds_dir,
    home: data.home,
    compact_after_turns: data.compact_after_turns,
    lore_scan_depth: data.lore_scan_depth,
    lore_token_budget: data.lore_token_budget,
    max_tool_rounds: data.max_tool_rounds,
    transcript_keep_after_compact: data.transcript_keep_after_compact,
    context: data.context || {
      max_tokens: 32768,
      generation_reserve: 4096,
      budget: {},
      history: { use_remaining: true, protect_recent_turns: 6 },
    },
    mini: data.mini || { max_tokens: 1200, recent_turns: 4, max_characters: 6 },
  };
}

export function SettingsPage() {
  const [form, setForm] = useState<FormState | null>(null);
  const [path, setPath] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([]);
  const [nmemHint, setNmemHint] = useState("");

  useEffect(() => {
    api
      .settings()
      .then((data) => {
        setForm(toForm(data));
        setPath(data.path);
        setKeySet(data.llm.api_key_set);
      })
      .catch((err: Error) => setError(err.message));
    api
      .spaces()
      .then((data) => {
        setSpaces(data.spaces);
        setNmemHint(data.available ? "" : data.error || "nmem 未连通");
      })
      .catch(() => setSpaces([]));
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const payload: SettingsPut = {
        ...form,
        llm: {
          ...form.llm,
          api_key: form.llm.clear_api_key ? null : form.llm.api_key.trim() || null,
          clear_api_key: form.llm.clear_api_key,
        },
      };
      const next = await api.saveSettings(payload);
      setForm(toForm(next));
      setPath(next.path);
      setKeySet(next.llm.api_key_set);
      setSaved("已保存，立即生效。");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (!form && !error) {
    return (
      <div className="flex min-h-dvh items-center justify-center font-ui text-secondary">
        <LoaderCircle className="mr-2 h-5 w-5 animate-spin" aria-hidden />
        读取设置…
      </div>
    );
  }

  if (!form) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <p className="text-destructive" role="alert">
          {error}
        </p>
        <Button className="mt-6" variant="secondary" asChild>
          <Link to="/">返回世界列表</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-2xl px-6 pb-24">
        <h1 className="font-display text-3xl font-semibold">设置</h1>
        <p className="mt-2 font-body text-secondary">
          模型走 NVIDIA NIM 的 Kimi K3，密钥在 Worker 里。对局参数写到 <span className="break-all font-ui text-sm">{path}</span>。
        </p>
        {error ? (
          <p className="mt-4 font-ui text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="mt-4 font-ui text-sm text-accent" role="status">
            {saved}
          </p>
        ) : null}

        <form className="mt-10 space-y-12" onSubmit={(event) => void onSubmit(event)}>
          <fieldset className="space-y-5">
            <legend className="font-display text-2xl font-semibold">模型接口</legend>
            <Checkbox
              id="breach"
              checked={form.llm.breach}
              onChange={(checked) => setForm({ ...form, llm: { ...form.llm, breach: checked } })}
            >
              R18G 破甲（成年虚构去和谐）
            </Checkbox>
            <Hint>系统层写宪章，每轮生成前再贴一条历史后指令（英文安全自评）。禁未成年。可覆盖 layers/breach.md 与 layers/breach_user.md。</Hint>
            <Field id="base_url" label="API 地址" hint="由 Worker 绑定，不能在网页里改。">
              <Input id="base_url" name="base_url" value={form.llm.base_url} readOnly />
            </Field>
            <Field id="model" label="模型" hint="moonshotai/kimi-k3。">
              <Input id="model" name="model" value={form.llm.model} readOnly />
            </Field>
            <p className="font-ui text-sm text-secondary">{keySet ? "NVIDIA 密钥已配置。" : "还没有 NVIDIA 密钥。部署时用 wrangler secret put NVIDIA_API_KEY。"}</p>
            <div className="grid gap-5 sm:grid-cols-3">
              <Field id="temperature" label="温度">
                <Input
                  id="temperature"
                  name="temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.05}
                  value={form.llm.temperature}
                  onChange={(event) => setForm({ ...form, llm: { ...form.llm, temperature: Number(event.target.value) } })}
                />
              </Field>
              <Field id="max_tokens" label="最大 tokens">
                <Input
                  id="max_tokens"
                  name="max_tokens"
                  type="number"
                  min={1}
                  value={form.llm.max_tokens}
                  onChange={(event) => setForm({ ...form, llm: { ...form.llm, max_tokens: Number(event.target.value) } })}
                />
              </Field>
              <Field id="timeout" label="超时（秒）">
                <Input
                  id="timeout"
                  name="timeout"
                  type="number"
                  min={1}
                  value={form.llm.timeout}
                  onChange={(event) => setForm({ ...form, llm: { ...form.llm, timeout: Number(event.target.value) } })}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-5">
            <legend className="font-display text-2xl font-semibold">Nowledge Mem</legend>
            <Checkbox
              id="nmem_enabled"
              checked={form.nmem.enabled}
              onChange={(checked) => setForm({ ...form, nmem: { ...form.nmem, enabled: checked } })}
            >
              启用 nmem（对局正文写入所选工作区）
            </Checkbox>
            {nmemHint ? <Hint>{nmemHint}</Hint> : null}
            <Field id="nmem_space" label="默认 nmem 工作区" hint="填 id（如 rp-mem），不要填显示名。未选不会写 default。选中后对局正文（含成人内容）会写入该空间。">
              <Input
                id="nmem_space"
                name="nmem_space"
                list="nmem-space-ids"
                value={form.nmem.space}
                placeholder="rp-mem"
                onChange={(event) => setForm({ ...form, nmem: { ...form.nmem, space: event.target.value } })}
              />
              <datalist id="nmem-space-ids">
                {spaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </datalist>
            </Field>
          </fieldset>

          <fieldset className="space-y-5">
            <legend className="font-display text-2xl font-semibold">记忆容量</legend>
            <div className="grid gap-5 sm:grid-cols-3">
              <Field id="world_char_limit" label="世界记忆字符">
                <Input
                  id="world_char_limit"
                  type="number"
                  min={1}
                  value={form.memory.world_char_limit}
                  onChange={(event) =>
                    setForm({ ...form, memory: { ...form.memory, world_char_limit: Number(event.target.value) } })
                  }
                />
              </Field>
              <Field id="player_char_limit" label="玩家记忆字符">
                <Input
                  id="player_char_limit"
                  type="number"
                  min={1}
                  value={form.memory.player_char_limit}
                  onChange={(event) =>
                    setForm({ ...form, memory: { ...form.memory, player_char_limit: Number(event.target.value) } })
                  }
                />
              </Field>
              <Field id="character_char_limit" label="角色记忆字符">
                <Input
                  id="character_char_limit"
                  type="number"
                  min={1}
                  value={form.memory.character_char_limit}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      memory: { ...form.memory, character_char_limit: Number(event.target.value) },
                    })
                  }
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-5">
            <legend className="font-display text-2xl font-semibold">对局与世界书</legend>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="compact_after_turns" label="压缩阈值（回合）">
                <Input
                  id="compact_after_turns"
                  type="number"
                  min={1}
                  value={form.compact_after_turns}
                  onChange={(event) => setForm({ ...form, compact_after_turns: Number(event.target.value) })}
                />
              </Field>
              <Field id="transcript_keep_after_compact" label="压缩后保留条数">
                <Input
                  id="transcript_keep_after_compact"
                  type="number"
                  min={0}
                  value={form.transcript_keep_after_compact}
                  onChange={(event) => setForm({ ...form, transcript_keep_after_compact: Number(event.target.value) })}
                />
              </Field>
              <Field id="lore_scan_depth" label="世界书扫描深度">
                <Input
                  id="lore_scan_depth"
                  type="number"
                  min={1}
                  value={form.lore_scan_depth}
                  onChange={(event) => setForm({ ...form, lore_scan_depth: Number(event.target.value) })}
                />
              </Field>
              <Field id="lore_token_budget" label="世界书 token 预算">
                <Input
                  id="lore_token_budget"
                  type="number"
                  min={1}
                  value={form.lore_token_budget}
                  onChange={(event) => setForm({ ...form, lore_token_budget: Number(event.target.value) })}
                />
              </Field>
              <Field id="max_tool_rounds" label="工具轮次上限">
                <Input
                  id="max_tool_rounds"
                  type="number"
                  min={1}
                  value={form.max_tool_rounds}
                  onChange={(event) => setForm({ ...form, max_tool_rounds: Number(event.target.value) })}
                />
              </Field>
              <Field id="context_max_tokens" label="Context 总预算">
                <Input
                  id="context_max_tokens"
                  type="number"
                  min={1024}
                  value={form.context.max_tokens}
                  onChange={(event) =>
                    setForm({ ...form, context: { ...form.context, max_tokens: Number(event.target.value) } })
                  }
                />
              </Field>
              <Field id="context_reserve" label="生成预留 tokens">
                <Input
                  id="context_reserve"
                  type="number"
                  min={256}
                  value={form.context.generation_reserve}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      context: { ...form.context, generation_reserve: Number(event.target.value) },
                    })
                  }
                />
              </Field>
              <Field id="mini_max_characters" label="Mini 角色上限">
                <Input
                  id="mini_max_characters"
                  type="number"
                  min={1}
                  value={form.mini.max_characters}
                  onChange={(event) =>
                    setForm({ ...form, mini: { ...form.mini, max_characters: Number(event.target.value) } })
                  }
                />
              </Field>
              <Field id="mini_max_tokens" label="Mini token 预算">
                <Input
                  id="mini_max_tokens"
                  type="number"
                  min={100}
                  value={form.mini.max_tokens}
                  onChange={(event) => setForm({ ...form, mini: { ...form.mini, max_tokens: Number(event.target.value) } })}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="space-y-5">
            <legend className="font-display text-2xl font-semibold">存储</legend>
            <Field id="worlds_dir" label="工作区" hint="Cloudflare R2。">
              <Input id="worlds_dir" value={form.worlds_dir} readOnly />
            </Field>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {busy ? "保存中" : "保存"}
            </Button>
            <Button type="button" variant="secondary" asChild>
              <Link to="/">返回世界列表</Link>
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}
