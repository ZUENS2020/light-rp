import { useEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, Trash2 } from 'lucide-react';
import { ApiError, api, errorText, readable } from './api';
import { characterName } from './Assets';
import type { Asset, Data, Snapshot } from './types';
import { Badge, Field, Modal, statusName } from './ui';

function idsOf(item: Data): string[] {
  return [
    ...new Set<string>(
      (item.sourceIds || item.evidence || []).flatMap((value: any) =>
        typeof value === 'string' ? [value] : value.sourceId ? [value.sourceId] : [],
      ),
    ),
  ];
}

export function SceneView({ scene, cast }: { scene?: Data | string; cast: Asset[] }) {
  if (!scene || (typeof scene === 'object' && !Object.keys(scene).length))
    return <p>场景随已提交剧情更新。</p>;
  if (typeof scene === 'string') return <p>{scene}</p>;
  const names = (value: unknown): string => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(names).filter(Boolean).join('、');
    if (typeof value === 'object')
      return Object.values(value).map(names).filter(Boolean).join(' · ');
    const text = String(value),
      asset = cast.find((item) => item.id === text);
    return asset
      ? characterName(asset)
      : /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text) || /^ent_[0-9a-f]+$/i.test(text)
        ? '尚未命名的人物'
        : text;
  };
  const fields = [
    ['地点', scene.location || scene.place],
    ['时间', scene.time || scene.storyTime],
    ['天气', scene.weather],
    ['人物', scene.present || scene.characterIds],
    ['正在发生', scene.ongoing || scene.activity],
  ];
  const summary = names(scene.summary || scene.description);
  return (
    <>
      {summary && <p>{summary}</p>}
      <dl className="scene-fields">
        {fields
          .filter(([, value]) => names(value))
          .map(([label, value]) => (
            <div key={String(label)}>
              <dt>{String(label)}</dt>
              <dd>{names(value)}</dd>
            </div>
          ))}
      </dl>
      {!summary && !fields.some(([, value]) => names(value)) && <p>场景随已提交剧情更新。</p>}
    </>
  );
}

/** Older audit records remain unchanged in evidence; the transcript displays their meaning. */
export function eventDisplayText(event: Data): string {
  const text = String(event.text || '');
  if (!['author', 'correction'].includes(event.role)) return text;
  const audit = text.match(
    /^作者将技能 (.+) 的版本 [0-9a-f-]{36} 状态设为 (active|suspended|retired|draft)$/i,
  );
  if (!audit) return text;
  return `作者将「${audit[1]}」标记为${({ active: '可用', suspended: '暂停', retired: '停用', draft: '候选' } as Data)[audit[2]]}。`;
}

export function ProcedureExplanation({ item }: { item: Data }) {
  const data = { ...item.data, ...item },
    successes = Number(data.successes ?? data.successCount ?? 0);
  let explanation: string;
  if (data.status === 'invalidated' || data.status === 'forgotten')
    explanation = '支撑原文或能力来源已失效，经验不再进入召回。';
  else if (data.counterexamples?.length || data.unresolved?.length)
    explanation = '存在方法反例或未决失败，处理证据前暂停使用。';
  else if (data.status === 'retired') explanation = '作者已停用这一方法，历史案例仍保留。';
  else if (data.manualStatus === 'suspended')
    explanation = '作者手动暂停。保留成功案例，重新启用仍检查能力和反例。';
  else if (data.manualStatus === 'active')
    explanation = '作者重新启用。能力、独立成功案例及反例检查已通过。';
  else if (data.status === 'active')
    explanation =
      '由已提交案例自动启用：角色具备能力，相同方法与前提下有至少两次独立成功，且没有未决反例。';
  else if (successes < 2)
    explanation =
      '经验候选：一次成功先作为案例，至少两次互不重叠的独立成功才可启用。重复摘要和未完成结果不计入成功。';
  else explanation = '经验候选：成功证据已达到门槛，还需有效的角色能力来源及无未决反例。';
  return <p className="procedure-explanation">{explanation}</p>;
}

export function EvidenceModal({
  item,
  snapshot,
  onClose,
  onDelete,
}: {
  item: Data;
  snapshot: Snapshot | null;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const [sources, setSources] = useState<Data[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(item);
  const [versions, setVersions] = useState<Data[] | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState('');
  const versionRequest = useRef(0);
  const branchId = snapshot?.branch.id || item.branchId;
  const ids = idsOf(selected);
  useEffect(() => {
    versionRequest.current++;
    setSelected(item);
    setVersions(null);
    setVersionError('');
    setVersionLoading(false);
    return () => {
      versionRequest.current++;
    };
  }, [item]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    void Promise.all(
      ids.map(async (id) => {
        const event = snapshot?.events.find((event) => event.sourceId === id || event.id === id);
        try {
          return { ...event, ...(await api(`/branches/${branchId}/sources/${id}`)) };
        } catch (error) {
          return {
            sourceId: id,
            error:
              error instanceof ApiError && error.status === 410
                ? '原文来源已删除，正文不会恢复。'
                : error instanceof ApiError && error.status === 404
                  ? '此来源不属于当前分支，或已被删除。'
                  : `原文读取失败：${errorText(error)}`,
          };
        }
      }),
    ).then((values) => {
      if (live) {
        setSources(values);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [selected, branchId]);
  async function loadVersions() {
    if (versions || versionLoading) return;
    const request = versionRequest.current;
    setVersionLoading(true);
    setVersionError('');
    try {
      const value = await api<Data[]>(`/branches/${branchId}/memories/${item.id}/versions`);
      if (versionRequest.current === request) setVersions(value);
    } catch (error) {
      if (versionRequest.current === request)
        setVersionError(
          error instanceof ApiError && error.status === 404
            ? '此记忆版本不属于当前分支历史。'
            : `版本历史读取失败：${errorText(error)}`,
        );
    } finally {
      if (versionRequest.current === request) setVersionLoading(false);
    }
  }
  const superseded = !!versions?.some((version) => version.supersedesId === selected.id);
  return (
    <Modal title="来源与证据" onClose={onClose} wide>
      <div className="modal-content evidence-view">
        <div className="evidence-subject">
          <span className="eyebrow">
            {selected.id === item.id ? 'CURRENT RECORD' : 'HISTORY / 历史版本'}
          </span>
          <h3>
            {selected.title || selected.name || selected.goal || selected.predicate || '记忆记录'}
          </h3>
          <p>
            {selected.text || selected.summary || readable(selected.value) || '此版本正文已清理。'}
          </p>
          <Badge subtle>
            {superseded
              ? '已被新版本替代'
              : statusName[selected.status || selected.outcome] || selected.kind || '已提交来源'}
          </Badge>
          {selected.revision != null && <span className="mono"> · v{selected.revision}</span>}
          {selected.data?.reason && (
            <p className="evidence-note">变更原因：{selected.data.reason}</p>
          )}
        </div>
        {item.memoryKey && item.id && (
          <details
            className="memory-version-history"
            onToggle={(event) => {
              if (event.currentTarget.open) void loadVersions();
            }}
          >
            <summary>版本历史与纠正记录</summary>
            <p className="evidence-note">
              仅展示当前分支继承范围内的版本。历史原文用于作者审计，已遗忘内容不会进入叙事召回。
            </p>
            {versionLoading && <p className="quiet">正在读取版本历史…</p>}
            {versionError && (
              <p className="inline-error" role="alert">
                {versionError}
                <button onClick={() => void loadVersions()}>重试读取</button>
              </p>
            )}
            {versions?.map((version) => (
              <article className="memory-version" key={version.id}>
                <div className="section-row">
                  <strong>
                    v{version.revision} · 回合 #{version.recordedSeq}
                  </strong>
                  <Badge subtle>
                    {versions.some((other) => other.supersedesId === version.id)
                      ? '已被新版本替代'
                      : statusName[version.status] || version.status}
                  </Badge>
                  <button
                    aria-pressed={selected.id === version.id}
                    onClick={() => setSelected(version)}
                  >
                    查看 v{version.revision} 原文
                  </button>
                </div>
                <p>{version.text || '正文已清理'}</p>
                {version.data?.reason && <p className="quiet">原因：{version.data.reason}</p>}
                {version.supersedesId && (
                  <small>替代此前版本{version.authority >= 100 ? ' · 作者明确纠正' : ''}</small>
                )}
              </article>
            ))}
            {versions?.length === 0 && <p className="quiet">没有可显示的历史版本。</p>}
          </details>
        )}
        {loading && (
          <p className="inline-loading">
            <LoaderCircle size={16} className="spin" />
            正在回读权威来源
          </p>
        )}
        {sources.map((source) => (
          <article className="evidence-event" key={source.sourceId}>
            <div className="section-row">
              <strong>
                {source.seq != null ? `#${source.seq}` : '原文'} ·{' '}
                {source.role === 'assistant'
                  ? '叙事'
                  : ['author', 'correction'].includes(source.role)
                    ? '作者'
                    : source.role === 'user'
                      ? '玩家'
                      : '证据'}
              </strong>
              {!source.error && (
                <button onClick={() => onDelete(source.sourceId)}>
                  <Trash2 size={13} />
                  删除原文
                </button>
              )}
            </div>
            {source.error ? (
              <p className="inline-error" role="alert">
                {source.error}
              </p>
            ) : (
              <>
                <p>{source.text}</p>
                {source.spans?.length > 0 && (
                  <details>
                    <summary>证据跨度与版本</summary>
                    <pre>{readable(source.spans)}</pre>
                  </details>
                )}
              </>
            )}
            <span className="mono source-id">{source.sourceId}</span>
          </article>
        ))}
        {!ids.length && <p className="quiet">此记录没有可展开的原文证据。</p>}
        <details>
          <summary>完整记录与版本</summary>
          <pre>{readable(selected)}</pre>
        </details>
      </div>
    </Modal>
  );
}

export function ContextModal({
  context,
  cast,
  tasks,
  selected,
  onSelect,
  query,
  setQuery,
  observer,
  setObserver,
  busy,
  reload,
  onEvidence,
  onClose,
}: {
  context: Data;
  cast: Asset[];
  tasks: Data[];
  selected: string;
  onSelect: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  observer: string;
  setObserver: (value: string) => void;
  busy: boolean;
  reload: () => void;
  onEvidence: (value: Data) => void;
  onClose: () => void;
}) {
  const triggers = context.worldbookTriggers;
  const actual = selected !== 'preview';
  return (
    <Modal title="上下文检查器" onClose={onClose} wide>
      <div className="modal-content context-view">
        <Field label="上下文来源">
          <select
            value={selected}
            onChange={(event) => onSelect(event.target.value)}
            disabled={busy}
          >
            <option value="preview">当前预览 · 根据最新剧情重新组装</option>
            {tasks.map((task, index) => (
              <option key={task.id} value={task.id}>
                {task.expectedHead != null
                  ? `回合 ${task.expectedHead + 1}`
                  : `最近生成 ${index + 1}`}{' '}
                · {statusName[task.status] || task.status} · 尝试 {task.attempt || 1}
              </option>
            ))}
          </select>
        </Field>
        {actual && (
          <p className="context-snapshot-note">
            这是该次生成实际保存的上下文。更换检索问题与观察视角请切换「当前预览」。
          </p>
        )}
        <div className="context-controls">
          <Field label="检索内容">
            <input
              disabled={actual || busy}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="当前场景、人物、问题…"
            />
          </Field>
          <Field label="观察视角">
            <select
              disabled={actual || busy}
              value={observer}
              onChange={(event) => setObserver(event.target.value)}
            >
              <option value="director">导演 · 世界真相</option>
              {cast.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {characterName(asset)} · 知情范围
                </option>
              ))}
            </select>
          </Field>
          <button className="primary" onClick={reload} disabled={busy}>
            {busy ? '读取中…' : actual ? '重新读取' : '重新召回'}
          </button>
        </div>
        <div className="context-summary">
          <Badge>{actual ? '本回合实际上下文' : '当前组装预览'}</Badge>
          <span>
            {context.tokens ?? context.tokenCount ?? 0} / {context.budget || '—'} tokens
          </span>
        </div>
        {context.warnings?.map((warning: string, index: number) => (
          <p key={index} className="inline-error">
            {warning}
          </p>
        ))}
        {actual && context.settings?.decisionModel && (
          <details open>
            <summary>
              记忆证据判断 ·{' '}
              {context.decisionAudit?.status === 'supported'
                ? '已确认'
                : context.decisionAudit?.status === 'rejected'
                  ? '未通过'
                  : context.decisionAudit?.status === 'uncertain'
                    ? '待确认'
                    : '待读取'}
            </summary>
            <p className="quiet">
              {context.settings.decisionModel.split('/').at(-1)}{' '}
              检查候选是否有原文依据，角色知情另有来源授权校验。
            </p>
            {context.decisionAuditError && <p className="quiet">{context.decisionAuditError}</p>}
            {context.decisionAudit?.candidates?.map((candidate: Data) => (
              <article className="preview-entry" key={candidate.path}>
                <strong>
                  {(
                    {
                      facts: '事实',
                      experiences: '经历',
                      capabilities: '能力',
                      procedureUses: '方法使用',
                    } as Data
                  )[candidate.path.split('.')[0]] || '候选'}{' '}
                  {Number(candidate.path.split('.')[1]) + 1}
                </strong>
                {Object.entries(candidate.answers as Record<string, Data>).map(([id, answer]) => (
                  <p key={id}>
                    {id === 'supported'
                      ? '内容证据'
                      : `获知证据 ${Number(id.replace('knowledge_', '')) + 1}`}
                    ：
                    {answer.verdict === 'supported'
                      ? '支持'
                      : answer.verdict === 'rejected'
                        ? '不支持'
                        : '待确认'}{' '}
                    · {Math.round(answer.probability * 1000) / 10}%
                  </p>
                ))}
              </article>
            ))}
          </details>
        )}
        <details open>
          <summary>召回的记忆 · {context.recall?.items?.length || 0}</summary>
          <div className="context-recall">
            {context.recall?.items?.map((item: Data) => (
              <article key={item.memory.id}>
                <div className="section-row">
                  <Badge subtle>{item.memory.kind}</Badge>
                  <span className="mono">{item.arms?.join(' / ')}</span>
                  <button onClick={() => onEvidence(item.memory)}>
                    <FileText size={12} />
                    原文
                  </button>
                </div>
                <p>{item.memory.text}</p>
                <small>
                  {item.memory.knownBy?.length
                    ? `知情角色：${item.memory.knownBy.map((id: string) => characterName(cast.find((c) => c.id === id))).join('、')}`
                    : '导演事实'}
                </small>
              </article>
            ))}
            {!context.recall?.items?.length && <p className="quiet">当前查询没有召回可见记忆。</p>}
          </div>
        </details>
        {triggers && (
          <details open>
            <summary>世界书触发 · {triggers.activated?.length || 0}</summary>
            {triggers.activated?.map((entry: Data, index: number) => (
              <article className="preview-entry matched" key={index}>
                <div className="section-row">
                  <strong>{entry.entryId}</strong>
                  <Badge subtle>{entry.position}</Badge>
                </div>
                <p>{entry.content}</p>
                <small>
                  递归轮次 {entry.round} · {entry.tokens || 0} tokens
                </small>
              </article>
            ))}
            {!triggers.activated?.length && <p className="quiet">没有设定条目进入当前上下文。</p>}
            <details>
              <summary>未注入原因</summary>
              <pre>{readable(triggers.skipped)}</pre>
            </details>
          </details>
        )}
        <details>
          <summary>实际组装消息 · {context.messages?.length || 0}</summary>
          {context.messages?.map((message: Data, index: number) => (
            <article className="context-message" key={index}>
              <span className="mono">
                {index + 1} · {message.role}
              </span>
              <pre>{message.content || message.text}</pre>
            </article>
          ))}
        </details>
        <details>
          <summary>完整召回记录</summary>
          <pre>{readable(context)}</pre>
        </details>
      </div>
    </Modal>
  );
}
