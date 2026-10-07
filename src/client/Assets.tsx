import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BookOpen,
  Copy,
  Plus,
  Save,
  UserRound,
  Search,
  Trash2,
} from 'lucide-react';
import type { Asset, Data } from './types';
import { normalizeWorldbook } from '../shared/assets';
import { api, download, errorText, post, readable } from './api';
import { Badge, Empty, Field, Modal } from './ui';

const newCharacter = () => ({
  name: '',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  alternate_greetings: [],
  creator_notes: '',
  extensions: {},
});
const newWorldbook = () => ({ name: '', description: '', entries: [] });
export const characterData = (data: Data): Data =>
  data?.data && typeof data.data === 'object' ? data.data : data;
export function bookEntries(data: Data): Data[] {
  const value = data?.entries || data?.data?.entries || [];
  return Array.isArray(value) ? value : Object.values(value);
}
export const characterName = (asset?: Asset) =>
  asset?.name || characterData(asset?.data || {}).name || '未命名角色';
const objectData = (value: unknown): Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};

function CharacterCapabilities({ body, patch }: { body: Data; patch: (value: Data) => void }) {
  const extensions = objectData(body.extensions),
    lightrp = objectData(extensions.lightrp);
  const capabilities: Data[] = Array.isArray(lightrp.capabilities) ? lightrp.capabilities : [];
  function update(next: Data[]) {
    patch({ extensions: { ...extensions, lightrp: { ...lightrp, capabilities: next } } });
  }
  function updateEntry(index: number, values: Data) {
    update(
      capabilities.map((entry, i) => (i === index ? { ...objectData(entry), ...values } : entry)),
    );
  }
  return (
    <section className="capability-editor">
      <div className="section-row">
        <h3>
          角色设定能力 <span className="count">{capabilities.length}</span>
        </h3>
        <button
          onClick={() => update([...capabilities, { name: '' }])}
          disabled={capabilities.length >= 128}
        >
          <Plus size={14} />
          添加能力
        </button>
      </div>
      <p className="quiet">
        明确写入角色设定的能力，例如航海或解锁。能力与经历中学到的经验方法分别保存；召回一个方法不会让角色获得能力。
      </p>
      {lightrp.capabilities != null && !Array.isArray(lightrp.capabilities) && (
        <p className="inline-error">
          原始能力字段格式异常，仍保留在完整 JSON 中。添加能力会改为可编辑的数组。
        </p>
      )}
      {capabilities.map((entry, index) => (
        <div className="capability-entry" key={index}>
          <div className="section-row">
            <span className="mono">ABILITY {String(index + 1).padStart(2, '0')}</span>
            <button
              className="icon-button"
              aria-label={`删除能力${index + 1}`}
              onClick={() => update(capabilities.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="form-grid">
            <Field label={`能力名称 ${index + 1}`}>
              <input
                maxLength={200}
                value={objectData(entry).name || ''}
                onChange={(event) => updateEntry(index, { name: event.target.value })}
                placeholder="例如：航海"
              />
            </Field>
            <Field label={`能力级别 ${index + 1}`} hint="可选，例如初级或熟练。">
              <input
                maxLength={200}
                value={objectData(entry).level || ''}
                onChange={(event) => updateEntry(index, { level: event.target.value })}
                placeholder="不指定级别"
              />
            </Field>
          </div>
        </div>
      ))}
      {!capabilities.length && (
        <p className="quiet">尚未指定能力。删除全部能力后保存，会明确清空此配置。</p>
      )}
    </section>
  );
}

export default function Assets({
  assets,
  refresh,
  notify,
}: {
  assets: Asset[];
  refresh: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [kind, setKind] = useState('character');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Asset | null | 'new'>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const filtered = assets.filter(
    (asset) =>
      asset.kind === kind &&
      characterName(asset).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append('kind', kind);
        body.append('file', file);
        await api('/assets', { method: 'POST', body });
      }
      await refresh();
      notify(`已导入 ${files.length} 份资料`);
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  async function duplicate(asset: Asset) {
    try {
      const data = structuredClone(asset.data);
      const body = characterData(data);
      body.name = `${characterName(asset)} · 副本`;
      await post('/assets', { kind: asset.kind, data });
      await refresh();
      notify('已复制资料');
    } catch (error) {
      notify(errorText(error), true);
    }
  }
  return (
    <section className="page assets-page">
      <div className="page-intro">
        <div>
          <span className="eyebrow">LIBRARY / 资料库</span>
          <h1>让人物与世界有据可依。</h1>
          <p>角色、设定和触发规则。每次保存生成独立版本。</p>
        </div>
      </div>
      <div className="page-toolbar">
        <div className="segmented">
          <button
            className={kind === 'character' ? 'selected' : ''}
            onClick={() => setKind('character')}
          >
            <UserRound size={16} />
            角色卡 <span>{assets.filter((a) => a.kind === 'character').length}</span>
          </button>
          <button
            className={kind === 'worldbook' ? 'selected' : ''}
            onClick={() => setKind('worldbook')}
          >
            <BookOpen size={16} />
            世界书 <span>{assets.filter((a) => a.kind === 'worldbook').length}</span>
          </button>
        </div>
        <div className="toolbar-actions">
          <button onClick={() => fileRef.current?.click()} disabled={busy}>
            <ArrowUpFromLine size={15} />
            {busy ? '正在导入…' : '导入文件'}
          </button>
          <button className="primary" onClick={() => setEditing('new')}>
            <Plus size={16} />
            新建{kind === 'character' ? '角色' : '世界书'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={kind === 'character' ? '.json,.png' : '.json'}
            multiple
            className="sr-only"
            aria-label="导入资料文件"
            onChange={(event) => void importFiles(event.target.files)}
          />
        </div>
      </div>
      <div className="library-search">
        <Search size={16} />
        <input
          aria-label="搜索资料"
          placeholder="搜索名称…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {!filtered.length ? (
        <Empty
          title={
            query ? '没有匹配的资料' : kind === 'character' ? '写下第一个角色' : '建立世界的规则'
          }
        >
          {kind === 'character'
            ? '支持角色卡 JSON 与 PNG 导入，完整保留原始扩展字段。'
            : '设定可以常驻，也可以随关键词进入当前上下文。'}
        </Empty>
      ) : (
        <div className="asset-grid">
          {filtered.map((asset) => (
            <article key={asset.id} className="asset-card">
              <div className="asset-card-head">
                <span className="asset-symbol">
                  {kind === 'character' ? (
                    <UserRound size={23} strokeWidth={1.3} />
                  ) : (
                    <BookOpen size={23} strokeWidth={1.3} />
                  )}
                </span>
                <Badge subtle>v{asset.revision}</Badge>
              </div>
              <button className="asset-title" onClick={() => setEditing(asset)}>
                {characterName(asset)}
              </button>
              <p>
                {characterData(asset.data).description ||
                  characterData(asset.data).personality ||
                  (kind === 'worldbook'
                    ? `${bookEntries(asset.data).length} 条设定`
                    : '尚未填写人物描述')}
              </p>
              <div className="asset-card-footer">
                <span className="mono">
                  {kind === 'worldbook' ? `${bookEntries(asset.data).length} ENTRIES` : 'CHARACTER'}
                </span>
                <div>
                  <button
                    className="icon-button"
                    aria-label={`复制${characterName(asset)}`}
                    onClick={() => void duplicate(asset)}
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`导出${characterName(asset)}`}
                    onClick={() =>
                      void download(
                        `/assets/${asset.id}/export`,
                        `${characterName(asset)}.json`,
                      ).catch((error) => notify(errorText(error), true))
                    }
                  >
                    <ArrowDownToLine size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {editing && (
        <AssetEditor
          kind={editing === 'new' ? kind : editing.kind}
          asset={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh();
            setEditing(null);
            notify('资料版本已保存');
          }}
          notify={notify}
        />
      )}
    </section>
  );
}

function AssetEditor({
  kind,
  asset,
  onClose,
  onSaved,
  notify,
}: {
  kind: string;
  asset?: Asset;
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [data, setData] = useState<Data>(() =>
    structuredClone(asset?.data || (kind === 'character' ? newCharacter() : newWorldbook())),
  );
  const [raw, setRaw] = useState(() => readable(data));
  const [tab, setTab] = useState('fields');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [previewResult, setPreviewResult] = useState<Data | null>(null);
  const [revision, setRevision] = useState(asset?.revision || 0);
  const [loading, setLoading] = useState(!!asset);
  const body = characterData(data);
  const entries = bookEntries(data);
  const normalizedBook = normalizeWorldbook(data);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    void api(`/assets/${asset.id}`)
      .then((value) => {
        if (live) {
          const full = value.raw || value.data;
          setData(full);
          setRaw(readable(full));
          setRevision(value.revision);
        }
      })
      .catch((error) => {
        if (live) setError(errorText(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [asset?.id]);
  function patchBody(patch: Data) {
    const next = data.data ? { ...data, data: { ...data.data, ...patch } } : { ...data, ...patch };
    setData(next);
    setRaw(readable(next));
  }
  function patchEntry(index: number, patch: Data) {
    const aliases: Data = {
      order: 'insertion_order',
      secondaryKeys: 'secondary_keys',
      useRegex: 'use_regex',
      caseSensitive: 'case_sensitive',
      matchWholeWords: 'match_whole_words',
      scanDepth: 'scan_depth',
      excludeRecursion: 'exclude_recursion',
      preventRecursion: 'prevent_recursion',
      delayUntilRecursion: 'delay_until_recursion',
      ignoreBudget: 'ignore_budget',
      outletName: 'outlet_name',
    };
    const next = entries.map((entry, i) => {
      if (i !== index) return entry;
      const current = { ...patch };
      const ext = { ...(entry.extensions || {}) };
      for (const [key, value] of Object.entries(patch)) {
        if (aliases[key]) current[aliases[key]] = value;
        if (key in ext) ext[key] = value;
        if (aliases[key] in ext) ext[aliases[key]] = value;
      }
      return { ...entry, ...current, ...(entry.extensions ? { extensions: ext } : {}) };
    });
    patchBody({ entries: next });
    setPreviewResult(null);
  }
  function selectTab(next: string) {
    if (tab === 'raw' && next !== 'raw') {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
          throw new Error('资料必须是 JSON 对象');
        setData(parsed);
        setError('');
      } catch (error) {
        setError(errorText(error));
        return;
      }
    }
    setTab(next);
  }
  async function save() {
    setError('');
    setBusy(true);
    try {
      const current = tab === 'raw' ? JSON.parse(raw) : data;
      if (!characterData(current).name?.trim()) throw new Error('请填写名称');
      const abilities = objectData(
        objectData(characterData(current).extensions).lightrp,
      ).capabilities;
      if (
        kind === 'character' &&
        Array.isArray(abilities) &&
        (abilities.length > 128 ||
          abilities.some(
            (ability) =>
              typeof objectData(ability).name !== 'string' ||
              !objectData(ability).name.trim() ||
              objectData(ability).name.length > 200 ||
              (objectData(ability).level != null &&
                (typeof objectData(ability).level !== 'string' ||
                  objectData(ability).level.length > 200)),
          ))
      )
        throw new Error('每项角色能力需要填写名称，级别可选；最多 128 项，每项文字最多 200 字');
      if (asset)
        await api(`/assets/${asset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ expectedRevision: revision, patch: current }),
        });
      else await post('/assets', { kind, data: current });
      await onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        asset
          ? `编辑 · ${characterName(asset)}`
          : `新建${kind === 'character' ? '角色卡' : '世界书'}`
      }
      onClose={onClose}
      wide
    >
      <div className="editor-tabs">
        <button className={tab === 'fields' ? 'selected' : ''} onClick={() => selectTab('fields')}>
          内容
        </button>
        <button className={tab === 'raw' ? 'selected' : ''} onClick={() => selectTab('raw')}>
          完整 JSON
        </button>
        {kind === 'worldbook' && (
          <button
            className={tab === 'preview' ? 'selected' : ''}
            onClick={() => selectTab('preview')}
          >
            触发预览
          </button>
        )}
        <span>{asset ? `当前 v${revision}` : '未保存'}</span>
      </div>
      <div className="modal-content">
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {loading && <p className="quiet">读取原始字段与扩展…</p>}
        {tab === 'raw' ? (
          <Field
            label="原始字段与扩展"
            hint="保存时保留此对象的全部字段。未知扩展不会被编辑表单丢弃。"
          >
            <textarea
              className="json-editor"
              spellCheck={false}
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
            />
          </Field>
        ) : tab === 'preview' ? (
          <>
            <Field
              label="测试文本"
              hint="服务端使用同一套规则计算关键词、条件、概率、递归和预算；固定种子便于复现。"
            >
              <textarea
                value={preview}
                onChange={(event) => {
                  setPreview(event.target.value);
                  setPreviewResult(null);
                }}
                placeholder="输入一段场景或对话…"
              />
            </Field>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setPreviewResult(
                    await post('/assets/preview-worldbook', {
                      data,
                      text: preview,
                      seed: 'preview',
                    }),
                  );
                } catch (error) {
                  setError(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              服务端触发预览
            </button>
            {previewResult && (
              <div className="server-preview">
                <h3>实际触发结果</h3>
                <p className="quiet">{previewResult.tokens || 0} tokens · 固定 seed: preview</p>
                {(previewResult.activated || []).map((entry: Data, index: number) => (
                  <div className="preview-entry matched" key={index}>
                    <Badge>注入</Badge>
                    <strong>{entry.entryId}</strong>
                    <p>{entry.content}</p>
                    <small>
                      {entry.position} · round {entry.round}
                    </small>
                  </div>
                ))}
                <details>
                  <summary>跳过原因</summary>
                  <pre>{readable(previewResult.skipped || [])}</pre>
                </details>
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="名称">
              <input
                value={body.name || ''}
                onChange={(event) => patchBody({ name: event.target.value })}
                placeholder={kind === 'character' ? '角色名称' : '世界书名称'}
              />
            </Field>
            <Field label={kind === 'character' ? '人物描述' : '世界书说明'}>
              <textarea
                value={body.description || ''}
                onChange={(event) => patchBody({ description: event.target.value })}
                placeholder={
                  kind === 'character' ? '身份、外貌、背景与重要经历…' : '适用的故事背景与设定范围…'
                }
              />
            </Field>
            {kind === 'character' ? (
              <>
                <div className="form-grid">
                  <Field label="性格">
                    <textarea
                      value={body.personality || ''}
                      onChange={(event) => patchBody({ personality: event.target.value })}
                    />
                  </Field>
                  <Field label="场景">
                    <textarea
                      value={body.scenario || ''}
                      onChange={(event) => patchBody({ scenario: event.target.value })}
                    />
                  </Field>
                </div>
                <Field label="开场白">
                  <textarea
                    value={body.first_mes ?? body.firstMessage ?? ''}
                    onChange={(event) => patchBody({ first_mes: event.target.value })}
                  />
                </Field>
                <Field label="示例对话">
                  <textarea
                    value={body.mes_example ?? body.mesExample ?? body.exampleMessages ?? ''}
                    onChange={(event) => patchBody({ mes_example: event.target.value })}
                  />
                </Field>
                <Field label="备用开场白" hint="每行一个开场白。">
                  <textarea
                    value={(body.alternate_greetings || body.alternateGreetings || []).join('\n')}
                    onChange={(event) =>
                      patchBody({
                        alternate_greetings: event.target.value.split('\n').filter(Boolean),
                      })
                    }
                  />
                </Field>
                <CharacterCapabilities body={body} patch={patchBody} />
                <details className="entry-advanced">
                  <summary>角色局部指引与作者备注</summary>
                  <Field label="局部系统指引">
                    <textarea
                      value={body.system_prompt ?? body.systemPrompt ?? ''}
                      onChange={(event) => patchBody({ system_prompt: event.target.value })}
                    />
                  </Field>
                  <Field label="历史后置指引">
                    <textarea
                      value={body.post_history_instructions ?? body.postHistoryInstructions ?? ''}
                      onChange={(event) =>
                        patchBody({ post_history_instructions: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="作者备注">
                    <textarea
                      value={body.creator_notes ?? body.creatorNotes ?? ''}
                      onChange={(event) => patchBody({ creator_notes: event.target.value })}
                    />
                  </Field>
                </details>
              </>
            ) : (
              <div className="worldbook-editor">
                <div className="book-options">
                  <div className="form-grid">
                    <Field label="扫描深度">
                      <input
                        type="number"
                        min="0"
                        max="10000"
                        value={normalizedBook.scanDepth}
                        onChange={(event) =>
                          patchBody({
                            scan_depth: Number(event.target.value),
                            scanDepth: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="世界书预算（token）">
                      <input
                        type="number"
                        min="0"
                        max="200000"
                        value={normalizedBook.tokenBudget}
                        onChange={(event) =>
                          patchBody({
                            token_budget: Number(event.target.value),
                            tokenBudget: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={normalizedBook.recursiveScanning}
                      onChange={(event) =>
                        patchBody({
                          recursive_scanning: event.target.checked,
                          recursiveScanning: event.target.checked,
                        })
                      }
                    />
                    递归扫描已触发条目
                  </label>
                </div>
                <div className="section-row">
                  <h3>
                    设定条目 <span className="count">{entries.length}</span>
                  </h3>
                  <button
                    onClick={() =>
                      patchBody({
                        entries: [
                          ...entries,
                          {
                            uid: crypto.randomUUID(),
                            keys: [],
                            content: '',
                            enabled: true,
                            constant: false,
                            order: entries.length,
                            position: 'before',
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    添加条目
                  </button>
                </div>
                {entries.map((entry, index) => (
                  <div className="worldbook-entry" key={index}>
                    <div className="section-row">
                      <span className="mono">ENTRY {String(index + 1).padStart(2, '0')}</span>
                      <button
                        className="icon-button"
                        aria-label={`删除条目${index + 1}`}
                        onClick={() =>
                          patchBody({ entries: entries.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <Field label="条目名称">
                      <input
                        value={entry.comment || entry.name || ''}
                        onChange={(event) =>
                          patchEntry(index, {
                            comment: event.target.value,
                            name: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="关键词" hint="以逗号分隔。">
                      <input
                        value={(entry.keys || entry.key || []).join(', ')}
                        onChange={(event) =>
                          patchEntry(index, {
                            keys: event.target.value
                              .split(/[,，]/)
                              .map((s) => s.trim())
                              .filter(Boolean),
                            key: event.target.value
                              .split(/[,，]/)
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </Field>
                    <Field label="内容">
                      <textarea
                        value={entry.content || ''}
                        onChange={(event) => patchEntry(index, { content: event.target.value })}
                      />
                    </Field>
                    <div className="entry-options">
                      <label>
                        <input
                          type="checkbox"
                          checked={entry.enabled !== false && !entry.disable}
                          onChange={(event) =>
                            patchEntry(index, {
                              enabled: event.target.checked,
                              disable: !event.target.checked,
                            })
                          }
                        />
                        启用
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!entry.constant}
                          onChange={(event) =>
                            patchEntry(index, { constant: event.target.checked })
                          }
                        />
                        常驻
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={!!entry.selective}
                          onChange={(event) =>
                            patchEntry(index, { selective: event.target.checked })
                          }
                        />
                        次级条件
                      </label>
                      <Field label="触发优先级">
                        <input
                          type="number"
                          value={normalizedBook.entries[index]?.priority ?? index}
                          onChange={(event) =>
                            patchEntry(index, { priority: Number(event.target.value) })
                          }
                        />
                      </Field>
                      <Field label="注入顺序">
                        <input
                          type="number"
                          value={normalizedBook.entries[index]?.order ?? index}
                          onChange={(event) =>
                            patchEntry(index, { order: Number(event.target.value) })
                          }
                        />
                      </Field>
                    </div>
                    {entry.selective && (
                      <Field label="次级关键词">
                        <input
                          value={(
                            entry.secondary_keys ||
                            entry.secondaryKeys ||
                            entry.keysecondary ||
                            []
                          ).join(', ')}
                          onChange={(event) =>
                            patchEntry(index, {
                              secondaryKeys: event.target.value
                                .split(/[,，]/)
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                        />
                      </Field>
                    )}
                    <div className="form-grid">
                      <Field label="注入位置">
                        <select
                          value={normalizedBook.entries[index]?.position || 'before'}
                          onChange={(event) => patchEntry(index, { position: event.target.value })}
                        >
                          <option value="before">角色设定前</option>
                          <option value="after">角色设定后</option>
                          <option value="at-depth">指定历史深度</option>
                          <option value="author-note-top">作者注释前</option>
                          <option value="author-note-bottom">作者注释后</option>
                          <option value="examples-top">对话示例前</option>
                          <option value="examples-bottom">对话示例后</option>
                          <option value="outlet">Outlet（当前叙事未启用）</option>
                        </select>
                      </Field>
                      <Field label="概率（%）">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={entry.probability ?? 100}
                          onChange={(event) =>
                            patchEntry(index, {
                              probability: Number(event.target.value),
                              useProbability: true,
                            })
                          }
                        />
                      </Field>
                    </div>
                    {normalizedBook.entries[index]?.position === 'at-depth' && (
                      <Field label="历史深度">
                        <input
                          type="number"
                          min="0"
                          value={normalizedBook.entries[index]?.depth ?? 0}
                          onChange={(event) =>
                            patchEntry(index, { depth: Number(event.target.value) })
                          }
                        />
                      </Field>
                    )}
                    {normalizedBook.entries[index]?.position === 'outlet' && (
                      <Field
                        label="Outlet 名称"
                        hint="原始配置会保留，当前叙事未启用 Outlet 注入。"
                      >
                        <input
                          value={normalizedBook.entries[index]?.outletName || ''}
                          onChange={(event) =>
                            patchEntry(index, { outletName: event.target.value })
                          }
                        />
                      </Field>
                    )}
                    <WorldbookAdvanced
                      entry={normalizedBook.entries[index]}
                      patch={(value) => patchEntry(index, value)}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        {asset && (
          <div className="export-actions">
            <button
              onClick={() =>
                void download(`/assets/${asset.id}/export`, `${characterName(asset)}.json`).catch(
                  (error) => notify(errorText(error), true),
                )
              }
            >
              <ArrowDownToLine size={14} />
              JSON
            </button>
            {kind === 'character' && (
              <button
                onClick={() =>
                  void download(
                    `/assets/${asset.id}/export?format=png`,
                    `${characterName(asset)}.png`,
                  ).catch((error) => notify(errorText(error), true))
                }
              >
                PNG
              </button>
            )}
          </div>
        )}
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => void save()} disabled={busy || loading}>
          <Save size={15} />
          {busy ? '保存中…' : '保存版本'}
        </button>
      </div>
    </Modal>
  );
}

function WorldbookAdvanced({ entry, patch }: { entry: Data; patch: (value: Data) => void }) {
  return (
    <details className="entry-advanced">
      <summary>匹配与递归设置</summary>
      <div className="entry-options">
        <label>
          <input
            type="checkbox"
            checked={entry.useRegex}
            onChange={(event) => patch({ useRegex: event.target.checked })}
          />
          正则关键词
        </label>
        <label>
          <input
            type="checkbox"
            checked={entry.caseSensitive}
            onChange={(event) => patch({ caseSensitive: event.target.checked })}
          />
          区分大小写
        </label>
        <label>
          <input
            type="checkbox"
            checked={entry.matchWholeWords}
            onChange={(event) => patch({ matchWholeWords: event.target.checked })}
          />
          完整词匹配
        </label>
        <label>
          <input
            type="checkbox"
            checked={entry.probabilityEnabled}
            onChange={(event) => patch({ useProbability: event.target.checked })}
          />
          启用概率
        </label>
      </div>
      <div className="form-grid">
        <Field label="次级匹配逻辑">
          <select
            value={entry.selectiveLogic}
            onChange={(event) => patch({ selectiveLogic: Number(event.target.value) })}
          >
            <option value="0">至少一个次级词出现（AND ANY）</option>
            <option value="1">非全部次级词出现（NOT ALL）</option>
            <option value="2">没有次级词出现（NOT ANY）</option>
            <option value="3">全部次级词出现（AND ALL）</option>
          </select>
        </Field>
        <Field label="消息角色">
          <select value={entry.role} onChange={(event) => patch({ role: event.target.value })}>
            <option value="system">系统设定</option>
            <option value="user">作者补充</option>
            <option value="assistant">叙事资料</option>
          </select>
        </Field>
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={entry.ignoreBudget}
          onChange={(event) => patch({ ignoreBudget: event.target.checked })}
        />
        忽略此世界书预算（仍受本回合总预算限制）
      </label>
      <div className="entry-options">
        <label>
          <input
            type="checkbox"
            checked={entry.excludeRecursion}
            onChange={(event) => patch({ excludeRecursion: event.target.checked })}
          />
          不接受递归触发
        </label>
        <label>
          <input
            type="checkbox"
            checked={entry.preventRecursion}
            onChange={(event) => patch({ preventRecursion: event.target.checked })}
          />
          不触发其他条目
        </label>
      </div>
      <div className="form-grid">
        <Field label="递归延迟轮次">
          <input
            type="number"
            min="0"
            max="32"
            value={entry.delayUntilRecursion}
            onChange={(event) => patch({ delayUntilRecursion: Number(event.target.value) })}
          />
        </Field>
        <Field label="条目扫描深度" hint="留空则使用世界书配置。">
          <input
            type="number"
            min="0"
            max="10000"
            value={entry.scanDepth ?? ''}
            onChange={(event) =>
              patch({ scanDepth: event.target.value === '' ? null : Number(event.target.value) })
            }
          />
        </Field>
      </div>
      {!!entry.unsupported?.length && (
        <p className="inline-error">
          这些原始扩展仍会保留，但当前不会参与触发：{entry.unsupported.join('、')}
        </p>
      )}
    </details>
  );
}
