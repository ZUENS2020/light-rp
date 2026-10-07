import { useEffect, useState } from 'react';
import { PlugZap, Save, Settings2 } from 'lucide-react';
import { api, errorText } from './api';
import type { Settings as Config } from './types';
import { Field } from './ui';

export default function Settings({
  settings,
  refresh,
  notify,
}: {
  settings: Config;
  refresh: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [form, setForm] = useState<Config>(settings);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ message: string; demo: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => setForm(settings), [settings]);
  function change(patch: Partial<Config>) {
    setForm((current) => ({ ...current, ...patch }));
    setProbe(null);
  }
  async function testConnection() {
    setProbing(true);
    setProbe(null);
    setError('');
    try {
      const result = await api('/settings/probe', { method: 'POST', body: JSON.stringify(form) });
      setProbe({
        message:
          result.mode === 'local-demo'
            ? '当前是本地演示，未调用远程模型。切换真实模式后可验证连接。'
            : result.message || '模型已返回连接测试结果。',
        demo: result.mode === 'local-demo',
      });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setProbing(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(form) });
      await refresh();
      notify('模型配置已保存');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page settings-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">CONFIGURATION / 配置</span>
          <h1>模型与叙事边界</h1>
          <p>统一叙事模型负责多角色。后台记忆处理使用辅助模型。</p>
        </div>
        <Settings2 size={28} strokeWidth={1.1} />
      </div>
      <form onSubmit={(event) => void save(event)} className="settings-form">
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="settings-section">
          <h2>连接</h2>
          <Field label="运行模式">
            <select
              value={form.mode}
              onChange={(event) => change({ mode: event.target.value as Config['mode'] })}
            >
              <option value="gateway">Cloudflare AI Gateway</option>
              <option value="openai">OpenAI 兼容接口</option>
              <option value="local-demo">本地演示 · 不调用真实模型</option>
            </select>
          </Field>
          <p className="config-note">
            {form.mode === 'local-demo'
              ? '演示模式使用确定性示例展示事件、记忆和经验流程；内容不来自真实模型。'
              : 'API 密钥由服务端环境变量提供。浏览器不读取或保存模型密钥。'}
          </p>
          <div className="form-grid">
            <Field label="接口地址">
              <input
                type="url"
                value={form.baseUrl || ''}
                onChange={(event) => change({ baseUrl: event.target.value })}
                placeholder="https://…/v1"
              />
            </Field>
            <Field
              label="提供方标识"
              hint="AI Gateway provider slug：workers-ai、openrouter 或 openai。"
            >
              <input
                value={form.provider || 'openai'}
                onChange={(event) => change({ provider: event.target.value })}
              />
            </Field>
          </div>
          <div className="form-grid">
            <Field label="叙事模型">
              <input
                required
                value={form.model || ''}
                onChange={(event) => change({ model: event.target.value })}
                placeholder="模型 ID"
              />
            </Field>
            <Field label="辅助模型">
              <input
                value={form.auxiliaryModel || ''}
                onChange={(event) => change({ auxiliaryModel: event.target.value })}
                placeholder="记忆抽取与整理模型"
              />
            </Field>
          </div>
        </div>
        <div className="settings-section">
          <h2>上下文</h2>
          <div className="form-grid">
            <Field label="上下文窗口（token）">
              <input
                type="number"
                min="4096"
                max="2000000"
                required
                value={form.contextWindow || 32768}
                onChange={(event) => change({ contextWindow: Number(event.target.value) })}
              />
            </Field>
            <Field label="最大正文输出（token）">
              <input
                type="number"
                min="128"
                max="65536"
                required
                value={form.maxOutput || 2048}
                onChange={(event) => change({ maxOutput: Number(event.target.value) })}
              />
            </Field>
          </div>
          <Field label="叙事指引" hint="作者指引与角色对白分开处理。角色经历不会修改系统授权。">
            <textarea
              className="system-prompt"
              value={form.systemPrompt || ''}
              onChange={(event) => change({ systemPrompt: event.target.value })}
              placeholder="叙事风格、视角与篇幅…"
            />
          </Field>
        </div>
        <div className="settings-save">
          {probe && (
            <p className="probe-result" role="status">
              {probe.demo ? '演示提示：' : '模型响应：'}
              {probe.message}
            </p>
          )}
          <button type="button" onClick={() => void testConnection()} disabled={busy || probing}>
            <PlugZap size={15} />
            {probing ? '正在测试…' : '测试连接'}
          </button>
          <button className="primary" type="submit" disabled={busy || probing}>
            <Save size={16} />
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>
      </form>
    </section>
  );
}
