import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  FileText,
  GitBranch,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import Assets, { characterData, characterName } from './Assets';
import Settings from './Settings';
import {
  ContextModal,
  EvidenceModal,
  ProcedureExplanation,
  SceneView,
  eventDisplayText,
} from './Inspectors';
import { API, api, asList, download, errorText, post, readable } from './api';
import type { Asset, Bootstrap, Branch, ChatEvent, Data, Snapshot, Story } from './types';
import { Badge, Empty, Field, Modal, statusName } from './ui';

const TERMINAL = new Set([
  'completed',
  'complete',
  'succeeded',
  'success',
  'failed',
  'cancelled',
  'canceled',
  'committed',
]);
const emptySnapshot = (branch: Branch): Snapshot => ({
  branch,
  sessions: [],
  events: [],
  memories: [],
  procedures: [],
  experiences: [],
  capabilities: [],
  jobs: [],
});
const saved = (key: string) => localStorage.getItem(`lightrp.${key}`) || '';
const remember = (key: string, value: string) => localStorage.setItem(`lightrp.${key}`, value);
function normalizeSnapshot(value: any): Snapshot {
  const records = (items: any) => asList<Data>(items).map((item) => ({ ...item.data, ...item }));
  return {
    ...emptySnapshot(value.branch),
    ...value,
    sessions: asList(value.sessions),
    events: asList(value.events),
    memories: records(value.memories),
    procedures: records(value.procedures),
    experiences: records(value.experiences),
    capabilities: records(value.capabilities),
    jobs: asList(value.jobs),
  };
}
const textOf = (item: Data) =>
  item.text ||
  item.content ||
  item.summary ||
  item.description ||
  (item.value
    ? `${item.predicate || ''} ${readable(item.value)}`
    : item.title || item.name || '未填写内容');
function sourceIds(item: Data): string[] {
  const values =
    item.sourceIds || item.source_ids || item.sources || item.evidence || item.provenance || [];
  return [
    ...new Set<string>(
      (Array.isArray(values) ? values : []).flatMap((source: any) =>
        typeof source === 'string'
          ? [source]
          : source.sourceId
            ? [source.sourceId]
            : source.eventId
              ? [source.eventId]
              : source.id
                ? [source.id]
                : [],
      ),
    ),
  ];
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [page, setPage] = useState('studio');
  const [storyId, setStoryId] = useState(saved('story'));
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [backgroundJobs, setBackgroundJobs] = useState<Data[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [history, setHistory] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [inspector, setInspector] = useState(true);
  const [modal, setModal] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Data | null>(null);
  const [context, setContext] = useState<Data | null>(null);
  const [contextQuery, setContextQuery] = useState('');
  const [contextTaskId, setContextTaskId] = useState('preview');
  const [observer, setObserver] = useState('director');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'roleplay' | 'author'>('roleplay');
  const [actorId, setActorId] = useState('');
  const [focus, setFocus] = useState<string[]>([]);
  const [task, setTask] = useState<Data | null>(null);
  const [sending, setSending] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [correction, setCorrection] = useState<Data | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    action: () => Promise<void>;
  } | null>(null);
  const notifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadToken = useRef(0);
  const bottom = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const branchRef = useRef(branchId);
  const historyBefore = useRef<number | undefined>(undefined);
  branchRef.current = branchId;
  const story = bootstrap?.stories.find((item) => item.id === storyId);
  const cast = (bootstrap?.assets || []).filter(
    (asset) =>
      asset.kind === 'character' &&
      (story?.characterIds || story?.castIds || []).includes(asset.id),
  );
  const isRunning = sending || (!!task && !TERMINAL.has(task.status || 'queued'));
  const demo = bootstrap?.settings.mode === 'local-demo';

  const notify = useCallback((message: string, isError = false) => {
    setNotice({ message, error: isError });
    if (notifyTimer.current) clearTimeout(notifyTimer.current);
    notifyTimer.current = setTimeout(() => setNotice(null), isError ? 8000 : 3500);
  }, []);
  const refreshBootstrap = useCallback(async () => {
    const result = await api<Bootstrap>('/bootstrap');
    setBootstrap({
      ...result,
      worlds: asList(result.worlds),
      stories: asList(result.stories),
      assets: asList(result.assets),
    });
  }, []);
  const refreshBranch = useCallback(async (id = branchRef.current) => {
    if (!id) return;
    const before = id === branchRef.current ? historyBefore.current : undefined;
    const value = normalizeSnapshot(
      await api(`/branches/${id}${before == null ? '' : `?beforeSeq=${before}`}`),
    );
    if (id === branchRef.current && before === historyBefore.current) setSnapshot(value);
    return value;
  }, []);
  useEffect(() => {
    void refreshBootstrap()
      .catch((error) => setError(errorText(error)))
      .finally(() => setLoading(false));
  }, [refreshBootstrap]);
  useEffect(() => {
    if (!bootstrap) return;
    if (!bootstrap.stories.some((s) => s.id === storyId))
      setStoryId(bootstrap.stories[0]?.id || '');
  }, [bootstrap, storyId]);
  useEffect(() => {
    const token = ++loadToken.current;
    setSnapshot(null);
    setBranches([]);
    setBranchId('');
    setTask(null);
    setInput('');
    if (!storyId) return;
    remember('story', storyId);
    void api(`/stories/${storyId}/branches`)
      .then((value) => {
        if (token !== loadToken.current) return;
        const items = asList<Branch>(value, 'branches');
        setBranches(items);
        const existing = items.find((b) => b.id === saved(`branch.${storyId}`));
        setBranchId(existing?.id || items[0]?.id || '');
      })
      .catch((error) => notify(errorText(error), true));
  }, [storyId, notify]);
  useEffect(() => {
    if (!branchId) return;
    historyBefore.current = undefined;
    remember(`branch.${storyId}`, branchId);
    setTask(null);
    setSnapshot(null);
    setError('');
    let live = true;
    void api(`/branches/${branchId}`)
      .then((value) => {
        if (!live) return;
        const next = normalizeSnapshot(value);
        setSnapshot(next);
        setSessionId(
          next.sessions.find((session) => session.id === saved(`session.${branchId}`))?.id ||
            next.sessions[0]?.id ||
            '',
        );
      })
      .catch((error) => {
        if (live) setError(errorText(error));
      });
    const savedTask = saved(`task.${branchId}`);
    if (savedTask)
      setTask({
        id: savedTask,
        status: 'queued',
        draftText: '',
        attempt: 0,
        inputText: saved(`input.${branchId}`),
      });
    return () => {
      live = false;
    };
  }, [branchId, storyId]);
  useEffect(() => {
    if (!branchId || page !== 'studio') return;
    let live = true;
    const update = async () => {
      if (document.hidden) return;
      const results = await Promise.allSettled([refreshBranch(branchId), api('/jobs')]);
      if (live && results[1].status === 'fulfilled')
        setBackgroundJobs(
          asList<Data>(results[1].value)
            .filter((job) => (job.branch_id || job.branchId) === branchId)
            .map((job) => ({
              ...job,
              jobType: 'background',
              title:
                job.kind === 'memory'
                  ? '记忆抽取与整理'
                  : job.kind === 'index'
                    ? '语义索引更新'
                    : '任务派发',
              text: job.last_error || '',
              attempt: job.attempts,
            })),
        );
    };
    void update();
    const timer = setInterval(() => void update(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [branchId, page, refreshBranch]);
  useEffect(() => {
    setActorId(story?.playerCharacterId || '');
    setFocus(story?.characterIds || story?.castIds || []);
  }, [storyId, story?.playerCharacterId]);
  useEffect(() => {
    if (sessionId && branchId) remember(`session.${branchId}`, sessionId);
  }, [sessionId, branchId]);
  useEffect(() => {
    if (!task?.id || TERMINAL.has(task.status || '')) return;
    const id = task.id,
      branch = branchId;
    remember(`task.${branch}`, id);
    const stream = new EventSource(`${API}/tasks/${id}/events`);
    let closed = false,
      polling = false;
    const finish = (value: Data) => {
      if (closed) return;
      closed = true;
      stream.close();
      localStorage.removeItem(`lightrp.task.${branch}`);
      setTask((current) => (current?.id === id ? { ...current, ...value } : current));
      void refreshBranch(branch).catch((error) => notify(errorText(error), true));
      if (value.status === 'failed')
        notify(value.error?.message || value.error || '生成未完成，草稿已保留，可重试。', true);
    };
    const update = (kind: string, value: Data) => {
      if (closed) return;
      if (kind === 'terminal') {
        finish(value);
        return;
      }
      setTask((current) => {
        if (!current || current.id !== id) return current;
        if (value.attempt != null && value.attempt < (current.attempt || 0)) return current;
        const next: Data = { ...current, attempt: value.attempt ?? current.attempt };
        if (kind === 'snapshot' || kind === 'reset')
          return { ...next, status: value.status || next.status, draftText: value.text || '' };
        if (kind === 'delta')
          return {
            ...next,
            status: 'running',
            draftText: `${current.draftText || ''}${value.text || ''}`,
          };
        return { ...next, status: value.status || next.status };
      });
    };
    for (const kind of ['snapshot', 'reset', 'delta', 'status', 'terminal'])
      stream.addEventListener(kind, (event) => {
        try {
          update(kind, JSON.parse((event as MessageEvent).data));
        } catch {}
      });
    stream.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        update(value.type || 'status', value);
      } catch {}
    };
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const value = await api(`/tasks/${id}`);
        if (TERMINAL.has(value.status)) finish(value);
        else
          setTask((current) =>
            current?.id === id ? { ...current, status: value.status, error: value.error } : current,
          );
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 404)
          finish({ status: 'failed', error: '任务已不存在，请重新发送。' });
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      closed = true;
      stream.close();
      clearInterval(timer);
    };
  }, [task?.id, task?.restartKey, branchId, refreshBranch, notify]);
  useEffect(() => {
    setContextTaskId('preview');
    setContext(null);
  }, [branchId]);
  useEffect(() => {
    const node = transcript.current;
    if (!node || node.scrollHeight - node.scrollTop - node.clientHeight < 220)
      bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [snapshot?.events.length, task?.draftText]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setPage('settings');
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);

  async function run(action: () => Promise<void>) {
    setActionBusy(true);
    try {
      await action();
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setActionBusy(false);
    }
  }
  async function ensureSession(branch = branchId) {
    if (sessionId && branch === branchId) return sessionId;
    const result = await post(`/branches/${branch}/sessions`, { title: '第一幕' });
    const id = result.id || result.session?.id;
    if (!id) throw new Error('会话创建结果缺少 ID');
    if (branch === branchId) setSessionId(id);
    return id;
  }
  async function send(
    text = input,
    target = branchId,
    expected = snapshot?.branch.headSeq || 0,
    inputMode = mode,
  ) {
    if (!text.trim() || !target || isRunning) return;
    setSending(true);
    try {
      const session = await ensureSession(target);
      const result = await post(`/branches/${target}/turns`, {
        commandId: crypto.randomUUID(),
        expectedHead: expected,
        sessionId: session,
        input: { mode: inputMode, text: text.trim(), ...(actorId ? { actorId } : {}) },
        focusCharacterIds: focus,
      });
      remember(`input.${target}`, text.trim());
      setInput('');
      setTask({
        id: result.taskId || result.id,
        status: 'queued',
        draftText: '',
        attempt: 0,
        inputText: text.trim(),
      });
      await refreshBranch(target);
    } catch (error) {
      notify(errorText(error), true);
      await refreshBranch().catch(() => {});
    } finally {
      setSending(false);
    }
  }
  async function fork(seq: number, name: string) {
    const result = await post(`/branches/${branchId}/forks`, { eventSeq: seq, name });
    const next = result.branch || result;
    const id = next.id || result.branchId;
    if (!id) throw new Error('分支创建结果缺少 ID');
    const items = asList<Branch>(await api(`/stories/${storyId}/branches`), 'branches');
    setBranches(items);
    setBranchId(id);
    setModal(null);
    notify('已建立平行分支');
    return next;
  }
  async function regenerate(event: ChatEvent) {
    const previous = [...(snapshot?.events || [])]
      .reverse()
      .find((item) => item.seq < event.seq && ['user', 'author', 'correction'].includes(item.role));
    if (!previous) {
      notify('没有找到此回合的原始输入', true);
      return;
    }
    setActionBusy(true);
    try {
      const forkSeq = Math.max(0, previous.seq - 1);
      const result = await post(`/branches/${branchId}/forks`, {
        eventSeq: forkSeq,
        name: `重写 · ${event.seq}`,
      });
      const next = result.branch || result;
      const id = next.id || result.branchId;
      const session = await post(`/branches/${id}/sessions`, { title: '重写回合' });
      const turn = await post(`/branches/${id}/turns`, {
        commandId: crypto.randomUUID(),
        expectedHead: next.headSeq ?? forkSeq,
        sessionId: session.id || session.session?.id,
        input: {
          mode: ['author', 'correction'].includes(previous.role) ? 'author' : 'roleplay',
          text: previous.text,
          ...(previous.actorId || previous.speakerId
            ? { actorId: previous.actorId || previous.speakerId }
            : {}),
        },
        focusCharacterIds: focus,
      });
      remember(`task.${id}`, turn.taskId || turn.id);
      setBranches(asList<Branch>(await api(`/stories/${storyId}/branches`), 'branches'));
      setBranchId(id);
      notify('已在新分支重新生成');
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setActionBusy(false);
    }
  }
  async function loadDemo() {
    await run(async () => {
      const result = await post('/demo');
      await refreshBootstrap();
      if (result.story?.id || result.storyId) selectStory(result.story?.id || result.storyId);
      notify('演示故事已载入');
    });
  }
  async function loadContext(query = contextQuery, selected = contextTaskId) {
    if (!branchId) return;
    setActionBusy(true);
    try {
      const result = await api(
        selected === 'preview'
          ? `/branches/${branchId}/context?query=${encodeURIComponent(query)}&observer=${encodeURIComponent(observer)}`
          : `/tasks/${selected}/context`,
      );
      if (selected !== 'preview' && result.settings?.decisionModel) {
        try {
          result.decisionAudit = await api(`/tasks/${selected}/decision`);
        } catch (error) {
          result.decisionAuditError = errorText(error);
        }
      }
      setContext(result);
      setContextTaskId(selected);
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setActionBusy(false);
    }
  }
  function selectStory(id: string) {
    setStoryId(id);
    setPage('studio');
    setSidebar(false);
  }
  const visibleEvents = (snapshot?.events || []).filter(
    (event) => history || !sessionId || event.sessionId === sessionId || !event.sessionId,
  );

  if (loading)
    return (
      <div className="boot-screen">
        <span className="brand-mark">L</span>
        <strong>LightRP</strong>
        <p>
          <LoaderCircle size={15} className="spin" />
          正在打开叙事工作台
        </p>
      </div>
    );
  if (!bootstrap)
    return (
      <div className="boot-screen">
        <span className="brand-mark">L</span>
        <h1>暂时无法打开工作台</h1>
        <p className="inline-error" role="alert">
          {error || '服务连接失败'}
        </p>
        <button className="primary" onClick={() => window.location.reload()}>
          重新连接
        </button>
      </div>
    );

  return (
    <div
      className={`app-shell ${sidebar ? 'show-sidebar' : ''} ${inspector ? 'show-inspector' : ''}`}
    >
      {sidebar && (
        <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebar(false)} />
      )}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">L</span>
          <div>
            <strong>LightRP</strong>
            <span>叙事工作台</span>
          </div>
          <button
            className="icon-button mobile-only"
            aria-label="关闭导航"
            onClick={() => setSidebar(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav className="main-nav" aria-label="主导航">
          <button
            className={page === 'studio' ? 'selected' : ''}
            onClick={() => {
              setPage('studio');
              setSidebar(false);
            }}
          >
            <MessageSquare size={17} />
            故事工作台<span className="shortcut">01</span>
          </button>
          <button
            className={page === 'assets' ? 'selected' : ''}
            onClick={() => {
              setPage('assets');
              setSidebar(false);
            }}
          >
            <BookOpen size={17} />
            资料库<span className="shortcut">02</span>
          </button>
        </nav>
        <div className="sidebar-section-title">
          <span>故事</span>
          <button className="icon-button" aria-label="新建故事" onClick={() => setModal('story')}>
            <Plus size={15} />
          </button>
        </div>
        <div className="story-list">
          {bootstrap.worlds.map((world) => (
            <div className="world-group" key={world.id}>
              <div className="world-label">
                <Layers3 size={12} />
                <span>{world.name}</span>
              </div>
              {bootstrap.stories
                .filter((s) => s.worldId === world.id)
                .map((item) => (
                  <button
                    className={`story-link ${item.id === storyId && page === 'studio' ? 'selected' : ''}`}
                    key={item.id}
                    data-story-id={item.id}
                    onClick={() => selectStory(item.id)}
                  >
                    <span className="story-dot" />
                    <span>{item.title || item.name || '未命名故事'}</span>
                    {item.id === storyId && <ChevronRight size={13} />}
                  </button>
                ))}
            </div>
          ))}
          {!bootstrap.stories.length && <p className="sidebar-empty">故事从一个场景开始。</p>}
        </div>
        <button className="new-story" onClick={() => setModal('story')}>
          <Plus size={16} />
          新建故事
        </button>
        <div className="sidebar-bottom">
          <button
            aria-label="模型设置"
            className={page === 'settings' ? 'selected' : ''}
            onClick={() => {
              setPage('settings');
              setSidebar(false);
            }}
          >
            <Settings2 size={17} />
            模型设置<span className="shortcut">⌘ ,</span>
          </button>
          <div className="connection">
            <span />
            <span>
              {demo
                ? '本地演示'
                : bootstrap.settings.mode === 'gateway'
                  ? 'AI Gateway'
                  : '模型接口'}
              <small>{bootstrap.settings.model || '未配置模型'}</small>
            </span>
            <ShieldCheck size={15} />
          </div>
        </div>
      </aside>
      <main className={`main-area ${page !== 'studio' ? 'full-page' : ''}`}>
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label="打开导航"
            onClick={() => setSidebar(true)}
          >
            <Menu size={19} />
          </button>
          <div className="breadcrumb">
            <span>{page === 'studio' ? '故事' : page === 'assets' ? '资料' : '设置'}</span>
            <ChevronRight size={13} />
            <strong>
              {page === 'studio'
                ? story?.title || story?.name || '工作台'
                : page === 'assets'
                  ? '角色与世界书'
                  : '模型与上下文'}
            </strong>
          </div>
          <div className="topbar-actions">
            {page === 'studio' && branchId && (
              <>
                <button onClick={() => void loadContext()} title="查看当前召回上下文">
                  <Eye size={16} />
                  <span>上下文</span>
                </button>
                <button
                  className="icon-button"
                  aria-label={inspector ? '收起检查器' : '打开检查器'}
                  onClick={() => setInspector((value) => !value)}
                >
                  {inspector ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                </button>
              </>
            )}
          </div>
        </header>
        {demo && (
          <div className="demo-banner">
            <span className="demo-label">DEMO</span>
            <span>本地演示模式 · 正文由确定性示例生成，不调用真实模型。</span>
            <button onClick={() => void loadDemo()} disabled={actionBusy}>
              载入演示故事
            </button>
            <button onClick={() => setPage('settings')}>
              配置模型
              <ArrowRight size={12} />
            </button>
          </div>
        )}
        {page === 'assets' ? (
          <Assets assets={bootstrap.assets} refresh={refreshBootstrap} notify={notify} />
        ) : page === 'settings' ? (
          <Settings settings={bootstrap.settings} refresh={refreshBootstrap} notify={notify} />
        ) : !story ? (
          <div className="welcome">
            <div className="welcome-overline">YOUR NEXT CHAPTER</div>
            <h1>
              每一次相遇，
              <br />
              <span>都有记忆。</span>
            </h1>
            <p>
              创建角色，建立世界。让故事在不同会话里延续，
              <br />
              让每个角色只记得属于自己的经历。
            </p>
            <div className="welcome-actions">
              <button className="primary" onClick={() => setModal('story')}>
                <Plus size={16} />
                创建故事
              </button>
              <button onClick={() => setPage('assets')}>
                <BookOpen size={16} />
                管理资料
              </button>
            </div>
            <div className="welcome-details">
              <div>
                <span>01</span>
                <strong>角色与设定</strong>
                <p>角色卡 · 世界书</p>
              </div>
              <div>
                <span>02</span>
                <strong>连续叙事</strong>
                <p>续聊 · 平行分支</p>
              </div>
              <div>
                <span>03</span>
                <strong>有来源的记忆</strong>
                <p>事实 · 关系 · 经验</p>
              </div>
            </div>
            {demo && (
              <button className="demo-load" onClick={() => void loadDemo()} disabled={actionBusy}>
                载入演示故事
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="story-toolbar">
              <div className="branch-picker">
                <GitBranch size={16} />
                <select
                  aria-label="当前分支"
                  value={branchId}
                  onChange={(event) => setBranchId(event.target.value)}
                  disabled={isRunning}
                >
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.parentBranchId || branch.parentId ? '↳ ' : ''}
                      {branch.name}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  aria-label="查看分支树"
                  onClick={() => setModal('branches')}
                >
                  <MoreHorizontal size={17} />
                </button>
              </div>
              <div className="session-picker">
                <Clock3 size={15} />
                <select
                  aria-label="当前会话"
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                  disabled={isRunning}
                >
                  <option value="" disabled>
                    选择会话
                  </option>
                  {snapshot?.sessions.map((session) => (
                    <option value={session.id} key={session.id}>
                      {session.title || session.name}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  aria-label="新建会话"
                  onClick={() => setModal('session')}
                  disabled={isRunning}
                >
                  <Plus size={16} />
                </button>
              </div>
              <button
                className="history-toggle"
                aria-pressed={history}
                aria-label="展示故事全史"
                title={history ? '点击只查看本会话' : '点击查看此分支完整故事'}
                onClick={() => setHistory((value) => !value)}
              >
                {history ? '故事全史' : '本会话'}
              </button>
              <span className="head-marker mono">
                {snapshot ? `#${String(snapshot.branch.headSeq).padStart(3, '0')}` : '…'}
              </span>
            </div>
            <div className="studio-body">
              <section className="conversation">
                <div className="transcript" ref={transcript} aria-label="故事正文">
                  {(snapshot?.hasEarlierEvents || snapshot?.eventsBeforeSeq) && (
                    <div className="history-navigation" aria-label="正文历史分页">
                      {snapshot.hasEarlierEvents && (
                        <button
                          onClick={() => {
                            historyBefore.current = snapshot.events[0]?.seq;
                            void refreshBranch()
                              .then(() => {
                                if (transcript.current) transcript.current.scrollTop = 0;
                              })
                              .catch((error) => notify(errorText(error), true));
                          }}
                        >
                          查看更早正文
                        </button>
                      )}
                      {snapshot.eventsBeforeSeq && (
                        <button
                          onClick={() => {
                            historyBefore.current = undefined;
                            void refreshBranch()
                              .then(() => bottom.current?.scrollIntoView({ block: 'end' }))
                              .catch((error) => notify(errorText(error), true));
                          }}
                        >
                          返回最新剧情
                        </button>
                      )}
                    </div>
                  )}
                  {error && (
                    <div className="inline-error" role="alert">
                      {error}
                      <button
                        onClick={() =>
                          void refreshBranch()
                            .then(() => setError(''))
                            .catch((error) => setError(errorText(error)))
                        }
                      >
                        重试
                      </button>
                    </div>
                  )}
                  {!snapshot && !error ? (
                    <div className="inline-loading">
                      <LoaderCircle className="spin" size={17} />
                      读取故事…
                    </div>
                  ) : !visibleEvents.length && !task ? (
                    <div className="chapter-empty">
                      <span className="eyebrow">CHAPTER 01</span>
                      <h2>
                        留一点空白，
                        <br />
                        让故事发生。
                      </h2>
                      <p>
                        从一句对白或一个场景开始。
                        <br />
                        切换「作者指令」，可以补充或调整世界事实。
                      </p>
                      {cast.length > 0 ? (
                        <div className="opening-cast">
                          {cast.map((asset) => (
                            <span key={asset.id}>{characterName(asset)}</span>
                          ))}
                        </div>
                      ) : (
                        <button onClick={() => setPage('assets')}>
                          先创建角色卡
                          <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {visibleEvents.map((event) => (
                        <article
                          key={event.id}
                          className={`story-event ${event.role === 'assistant' || event.role === 'narrator' ? 'narration' : 'user-event'} ${['author', 'correction'].includes(event.role) ? 'author-event' : ''}`}
                        >
                          <div className="event-meta">
                            <span>
                              {event.role === 'assistant' || event.role === 'narrator'
                                ? '叙事'
                                : ['author', 'correction'].includes(event.role)
                                  ? '作者指令'
                                  : event.actorId || event.speakerId
                                    ? characterName(
                                        bootstrap.assets.find(
                                          (asset) =>
                                            asset.id === (event.actorId || event.speakerId),
                                        ),
                                      )
                                    : '玩家'}
                            </span>
                            <span className="event-seq mono">
                              {String(event.seq).padStart(3, '0')}
                            </span>
                            <div className="event-actions">
                              <button
                                className="icon-button"
                                aria-label={`查看回合${event.seq}来源`}
                                onClick={() =>
                                  setEvidence({
                                    ...event,
                                    branchId,
                                    title: `回合 ${event.seq}`,
                                    sourceIds: [event.sourceId || event.id],
                                  })
                                }
                              >
                                <FileText size={13} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`从回合${event.seq}分叉`}
                                onClick={() => {
                                  setEvidence({ ...event, fork: true });
                                  setModal('fork');
                                }}
                                disabled={isRunning}
                              >
                                <GitBranch size={13} />
                              </button>
                              {['assistant', 'narrator'].includes(event.role) && (
                                <button
                                  className="icon-button"
                                  aria-label={`重新生成回合${event.seq}`}
                                  onClick={() => void regenerate(event)}
                                  disabled={isRunning || actionBusy}
                                >
                                  <RotateCcw size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="prose">
                            {eventDisplayText(event)
                              .split(/\n\n+/)
                              .map((paragraph, index) => (
                                <p key={index}>{paragraph}</p>
                              ))}
                          </div>
                        </article>
                      ))}
                      {task && !TERMINAL.has(task.status) && (
                        <article className="story-event narration live-event">
                          <div className="event-meta">
                            <span>
                              <LoaderCircle size={12} className="spin" />
                              {task.draftText ? '正在写下这一幕' : '正在准备上下文'}
                            </span>
                            <span className="mono">STREAM</span>
                          </div>
                          <div className="prose" aria-live="polite">
                            <p>{task.draftText || '角色、世界与记忆正在进入当前场景…'}</p>
                          </div>
                        </article>
                      )}
                      {task && ['cancelled', 'canceled'].includes(task.status) && (
                        <div className="task-failure">
                          <strong>这一回合已取消</strong>
                          {task.draftText && (
                            <details>
                              <summary>查看保存的草稿</summary>
                              <p>{task.draftText}</p>
                            </details>
                          )}
                          <button
                            onClick={() => {
                              setInput(task.inputText || saved(`input.${branchId}`));
                              setTask(null);
                            }}
                          >
                            恢复原始输入
                          </button>
                        </div>
                      )}
                      {task?.status === 'failed' && (
                        <div className="task-failure" role="alert">
                          <strong>这一回合尚未完成</strong>
                          <p>
                            {typeof task.error === 'string'
                              ? task.error
                              : task.error?.message || '草稿已保存，可以重试。'}
                          </p>
                          {task.draftText && (
                            <details>
                              <summary>查看保存的草稿</summary>
                              <p>{task.draftText}</p>
                            </details>
                          )}
                          <button
                            onClick={() =>
                              void run(async () => {
                                const value = await post(`/tasks/${task.id}/retry`);
                                setTask({
                                  ...task,
                                  id: value.taskId || value.id || task.id,
                                  status: 'queued',
                                  draftText: '',
                                  attempt: (task.attempt || 0) + 1,
                                  restartKey: crypto.randomUUID(),
                                });
                              })
                            }
                          >
                            重试生成
                            <RotateCcw size={14} />
                          </button>
                        </div>
                      )}
                    </>
                  )}
                  <div ref={bottom} />
                </div>
                <div className="composer-wrap">
                  <div className="composer">
                    <div className="composer-controls">
                      <div className="input-mode">
                        <button
                          className={mode === 'roleplay' ? 'selected' : ''}
                          onClick={() => setMode('roleplay')}
                        >
                          角色对白
                        </button>
                        <button
                          className={mode === 'author' ? 'selected' : ''}
                          onClick={() => setMode('author')}
                        >
                          作者指令
                        </button>
                      </div>
                      <select
                        aria-label="玩家身份"
                        value={actorId}
                        onChange={(event) => setActorId(event.target.value)}
                      >
                        <option value="">玩家 · 自由视角</option>
                        {cast.map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {characterName(asset)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      aria-label="输入剧情"
                      placeholder={
                        mode === 'author'
                          ? '描述场景、提出叙事指引或补充事实…'
                          : '说些什么，或描述你的行动…'
                      }
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                      rows={3}
                      disabled={!snapshot}
                    />
                    <div className="composer-bottom">
                      <span>
                        {mode === 'author'
                          ? '作为作者信息进入故事'
                          : '对白与陈述不会自动成为世界事实'}
                      </span>
                      {isRunning ? (
                        <button
                          className="stop-button"
                          onClick={() =>
                            void run(async () => {
                              await post(`/tasks/${task?.id}/cancel`);
                              notify('已请求取消');
                            })
                          }
                          disabled={!task?.id || actionBusy}
                        >
                          <Square size={13} />
                          停止
                        </button>
                      ) : (
                        <button
                          className="send-button"
                          aria-label="发送剧情"
                          onClick={() => void send()}
                          disabled={!input.trim() || !snapshot || actionBusy}
                        >
                          <span>发送</span>
                          <Send size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="composer-footnote">
                    <span>⌘ / Ctrl + Enter 发送</span>
                    <span>
                      {bootstrap.settings.model} · {demo ? '演示' : '统一叙事'}
                    </span>
                  </div>
                </div>
              </section>
              {inspector && (
                <Inspector
                  snapshot={
                    snapshot
                      ? {
                          ...snapshot,
                          jobs: [
                            ...snapshot.jobs.map((job) => ({
                              ...job,
                              title: '叙事生成',
                              text:
                                typeof job.error === 'string'
                                  ? job.error
                                  : job.error?.message || '',
                            })),
                            ...backgroundJobs,
                          ],
                        }
                      : null
                  }
                  assets={bootstrap.assets}
                  cast={cast}
                  focus={focus}
                  setFocus={setFocus}
                  onEvidence={(item) => setEvidence({ ...item, branchId })}
                  onCorrection={(item) => setCorrection(item)}
                  onForget={(item) =>
                    setConfirm({
                      title: '遗忘此记忆',
                      message: '此记忆将从当前分支召回中移除；原文事件仍保留。',
                      action: async () => {
                        await post(`/branches/${branchId}/memories/${item.id}/forget`);
                        await refreshBranch();
                        notify('已遗忘此记忆');
                      },
                    })
                  }
                  onStatus={(item, status) =>
                    void run(async () => {
                      await post(`/branches/${branchId}/procedures/${item.id}/status`, {
                        status,
                        commandId: crypto.randomUUID(),
                        expectedHead: snapshot?.branch.headSeq,
                      });
                      await refreshBranch();
                      notify(status === 'active' ? '经验已启用' : '经验已停用');
                    })
                  }
                  onRebuild={() =>
                    void run(async () => {
                      if (!snapshot) return;
                      await post(`/branches/${branchId}/rebuild`, {
                        commandId: crypto.randomUUID(),
                        expectedHead: snapshot.branch.headSeq,
                      });
                      notify('记忆重建已排队，将依据当前分支原文重新整理');
                      await refreshBranch();
                    })
                  }
                  onRetry={(job) =>
                    void run(async () => {
                      if (job.jobType === 'background') {
                        await post(`/jobs/${job.id}/retry`);
                        notify('整理任务已重新排队');
                        await refreshBranch();
                        return;
                      }
                      const value = await post(`/tasks/${job.taskId || job.id}/retry`);
                      setTask({
                        id: value.taskId || value.id || job.taskId || job.id,
                        status: 'queued',
                        draftText: '',
                        restartKey: crypto.randomUUID(),
                      });
                      await refreshBranch();
                    })
                  }
                  onClose={() => setInspector(false)}
                />
              )}
            </div>
            <div className="story-statusbar">
              <span>
                <span className="status-dot" />
                {isRunning ? '正在生成' : '已连接'}
                {snapshot &&
                  ` · ${snapshot.memories.filter((m) => m.status === 'active').length} 条记忆`}
              </span>
              <button
                onClick={() =>
                  void download(
                    `/branches/${branchId}/export`,
                    `${story.title || story.name}.json`,
                  ).catch((error) => notify(errorText(error), true))
                }
              >
                <ArrowDownToLine size={12} />
                导出故事
              </button>
            </div>
          </>
        )}
      </main>
      {notice && (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <X size={15} /> : <Check size={15} />}
          <span>{notice.message}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {modal === 'story' && (
        <StoryModal
          bootstrap={bootstrap}
          onClose={() => setModal(null)}
          onCreate={async (data) => {
            const value = await post('/stories', data);
            await refreshBootstrap();
            selectStory(value.id || value.story?.id);
            setModal(null);
          }}
          onWorld={async (name) => {
            const world = await post('/worlds', { name });
            await refreshBootstrap();
            return world.id;
          }}
          onAssets={() => {
            setModal(null);
            setPage('assets');
          }}
        />
      )}
      {modal === 'session' && (
        <TextModal
          title="新建会话"
          label="会话标题"
          initial={`新的一幕 ${new Date().toLocaleDateString('zh-CN')}`}
          description="新会话会接续此分支的事实、关系和角色经历。"
          onClose={() => setModal(null)}
          submit={async (title) => {
            const value = await post(`/branches/${branchId}/sessions`, { title });
            await refreshBranch();
            setSessionId(value.id || value.session?.id);
            setModal(null);
            notify('会话已创建，故事记忆继续保留');
          }}
        />
      )}
      {modal === 'fork' && (
        <TextModal
          title="建立平行分支"
          label="分支名称"
          initial={`分支 · ${evidence?.seq ?? snapshot?.branch.headSeq ?? 0}`}
          description={`继承回合 ${evidence?.seq ?? snapshot?.branch.headSeq ?? 0} 之前的合法事件与记忆。后续剧情相互独立。`}
          onClose={() => {
            setModal(null);
            if (evidence?.fork) setEvidence(null);
          }}
          submit={async (name) => {
            await fork(evidence?.seq ?? snapshot?.branch.headSeq ?? 0, name);
            setEvidence(null);
          }}
        />
      )}
      {modal === 'branches' && (
        <Modal title="故事分支" onClose={() => setModal(null)}>
          <div className="branch-tree">
            {branches.map((branch) => (
              <button
                key={branch.id}
                className={`${branch.id === branchId ? 'selected' : ''} ${branch.parentBranchId || branch.parentId ? 'child-branch' : ''}`}
                onClick={() => {
                  if (!isRunning) {
                    setBranchId(branch.id);
                    setModal(null);
                  }
                }}
                disabled={isRunning}
              >
                <GitBranch size={17} />
                <span>
                  <strong>{branch.name}</strong>
                  <small>
                    {branch.parentBranchId || branch.parentId
                      ? `由「${branches.find((b) => b.id === (branch.parentBranchId || branch.parentId))?.name || '父分支'}」于 #${branch.forkSeq ?? branch.forkEventSeq ?? '—'} 分叉`
                      : '初始故事线'}
                  </small>
                </span>
                {branch.id === branchId && <Badge>当前</Badge>}
              </button>
            ))}
          </div>
          <div className="modal-footer">
            <button
              className="primary"
              onClick={() => {
                setEvidence(null);
                setModal('fork');
              }}
              disabled={isRunning}
            >
              <Plus size={15} />
              从当前回合分叉
            </button>
          </div>
        </Modal>
      )}
      {evidence && !evidence.fork && (
        <EvidenceModal
          item={evidence}
          snapshot={snapshot}
          onClose={() => setEvidence(null)}
          onDelete={(id) =>
            setConfirm({
              title: '删除原文来源',
              message: '这会删除原文，并在所有派生分支中失效相关记忆、摘要与经验。此操作无法撤销。',
              action: async () => {
                await api(`/sources/${id}`, { method: 'DELETE' });
                await refreshBranch();
                setEvidence(null);
                notify('来源已删除，相关记忆已失效');
              },
            })
          }
        />
      )}
      {context && (
        <ContextModal
          context={context}
          cast={cast}
          tasks={snapshot?.jobs || []}
          selected={contextTaskId}
          onSelect={(selected) => void loadContext(contextQuery, selected)}
          query={contextQuery}
          setQuery={setContextQuery}
          observer={observer}
          setObserver={setObserver}
          busy={actionBusy}
          reload={() => void loadContext()}
          onEvidence={(item) => {
            setContext(null);
            setEvidence({ ...item, branchId });
          }}
          onClose={() => setContext(null)}
        />
      )}
      {correction && (
        <AuthorCorrectionModal
          item={correction}
          branchId={branchId}
          expectedHead={snapshot?.branch.headSeq ?? 0}
          onClose={() => setCorrection(null)}
          onSaved={async (target) => {
            await refreshBranch(target);
            setCorrection(null);
            notify(correction.id ? '纠正已记录' : '作者设定已记录');
          }}
        />
      )}
      {confirm && (
        <Modal title={confirm.title} onClose={() => !actionBusy && setConfirm(null)}>
          <div className="modal-content">
            <p className="confirm-message">{confirm.message}</p>
          </div>
          <div className="modal-footer">
            <button onClick={() => setConfirm(null)} disabled={actionBusy}>
              取消
            </button>
            <button
              className="danger-button"
              disabled={actionBusy}
              onClick={() =>
                void run(async () => {
                  await confirm.action();
                  setConfirm(null);
                })
              }
            >
              {actionBusy ? '处理中…' : '确认' + confirm.title}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Inspector({
  snapshot,
  assets,
  cast,
  focus,
  setFocus,
  onEvidence,
  onCorrection,
  onForget,
  onStatus,
  onRetry,
  onRebuild,
  onClose,
}: {
  snapshot: Snapshot | null;
  assets: Asset[];
  cast: Asset[];
  focus: string[];
  setFocus: (value: string[]) => void;
  onEvidence: (value: Data) => void;
  onCorrection: (value: Data) => void;
  onForget: (value: Data) => void;
  onStatus: (value: Data, status: string) => void;
  onRetry: (value: Data) => void;
  onRebuild: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState('memory');
  const [actor, setActor] = useState('all');
  const ownerName = (id?: string) => {
    if (!id) return '世界';
    const asset = assets.find((a) => a.id === id);
    return asset ? characterName(asset) : id === 'author' ? '作者' : id;
  };
  const tabs = [
    { id: 'memory', label: '记忆' },
    { id: 'relations', label: '关系' },
    { id: 'experience', label: '经历' },
    { id: 'skills', label: '经验' },
    { id: 'jobs', label: '任务' },
  ];
  let records: Data[] = [];
  if (snapshot)
    records =
      tab === 'memory'
        ? snapshot.memories.filter(
            (m) =>
              ![
                'relation',
                'relationship',
                'procedure',
                'experience',
                'episode',
                'observation',
              ].includes(m.kind || m.type),
          )
        : tab === 'relations'
          ? snapshot.memories.filter((m) => ['relation', 'relationship'].includes(m.kind || m.type))
          : tab === 'experience'
            ? [...snapshot.experiences, ...snapshot.memories.filter((m) => m.kind === 'episode')]
            : tab === 'skills'
              ? snapshot.procedures
              : snapshot.jobs;
  records = records.filter(
    (item) =>
      actor === 'all' ||
      item.actorId === actor ||
      item.subject === actor ||
      item.subjectId === actor ||
      item.observerId === actor,
  );
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <span className="eyebrow">STORY STATE</span>
        <button className="icon-button inspector-close" aria-label="关闭检查器" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <section className="scene-section">
        <div className="section-row">
          <h3>当前场景</h3>
          <span className="mono">LIVE</span>
        </div>
        <div className="scene-content">
          <SceneView scene={snapshot?.branch.scene} cast={cast} />
        </div>
      </section>
      <section className="cast-section">
        <div className="section-row">
          <h3>在场角色</h3>
          <span className="count">{cast.length}</span>
        </div>
        {cast.length ? (
          cast.map((asset) => (
            <label className="cast-row" key={asset.id}>
              <span className="cast-avatar">{characterName(asset).slice(0, 1)}</span>
              <span>
                <strong>{characterName(asset)}</strong>
                <small>{characterData(asset.data).personality || '独立的知情与经历'}</small>
              </span>
              <input
                type="checkbox"
                checked={focus.includes(asset.id)}
                onChange={(event) =>
                  setFocus(
                    event.target.checked
                      ? [...focus, asset.id]
                      : focus.filter((id) => id !== asset.id),
                  )
                }
                aria-label={`关注${characterName(asset)}`}
              />
            </label>
          ))
        ) : (
          <p className="quiet">此故事尚未绑定角色。</p>
        )}
      </section>
      <div className="inspector-tabs" role="tablist" aria-label="故事状态分类">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'jobs' && snapshot?.jobs.some((j) => j.status === 'failed') && (
              <span className="notification-dot" />
            )}
          </button>
        ))}
      </div>
      <div className="inspector-filter">
        <select
          aria-label="按角色筛选记忆"
          value={actor}
          onChange={(event) => setActor(event.target.value)}
        >
          <option value="all">所有角色与世界</option>
          {cast.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {characterName(asset)}
            </option>
          ))}
        </select>
        {tab === 'memory' && (
          <button
            className="icon-button"
            aria-label="添加作者设定"
            onClick={() => onCorrection({})}
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      <div className="inspector-records">
        {!records.length && (
          <div className="inspector-empty">
            <FileText size={23} strokeWidth={1.2} />
            <p>
              {tab === 'skills'
                ? '一次成功先留下案例。\n有独立证据后，经验才会启用。'
                : tab === 'jobs'
                  ? '当前没有后台任务。'
                  : '已提交的故事会在这里留下痕迹。'}
            </p>
          </div>
        )}
        {records.map((item) => (
          <article
            className="memory-record"
            data-memory-id={item.id}
            data-kind={item.kind}
            data-status={item.status}
            key={item.id || item.revisionId}
          >
            <div className="record-heading">
              <span>{ownerName(item.actorId || item.subjectId || item.subject)}</span>
              <Badge subtle>
                {(
                  {
                    canon: '事实',
                    belief: '认知',
                    relation: '关系',
                    episode: '情节',
                    experience: '案例',
                    procedure: '经验',
                  } as Data
                )[item.kind] ||
                  item.kind ||
                  '记录'}{' '}
                ·{' '}
                {item.kind === 'procedure' && item.status === 'active'
                  ? '已启用'
                  : item.kind === 'experience'
                    ? statusName[item.outcome] || item.outcome
                    : statusName[item.status || item.outcome] || item.status || '已提交'}
              </Badge>
            </div>
            {(item.title || item.name || item.goal) && (
              <strong className="record-title">{item.title || item.name || item.goal}</strong>
            )}
            <p>
              {item.subject && assets.some((a) => a.id === item.subject)
                ? textOf(item).replaceAll(item.subject, ownerName(item.subject))
                : textOf(item)}
            </p>
            {tab === 'skills' && (
              <>
                <ProcedureExplanation item={item} />
                <div className="skill-evidence-count">
                  <ShieldCheck size={12} />
                  {item.successes ??
                    item.successCount ??
                    item.supportCount ??
                    item.evidenceCount ??
                    item.successEvidenceCount ??
                    0}{' '}
                  次独立成功证据
                </div>
                {(item.counterexamples?.length > 0 || item.unresolved?.length > 0) && (
                  <p className="inline-error">
                    {item.counterexamples?.length || 0} 条方法反例 · {item.unresolved?.length || 0}{' '}
                    条未决失败
                  </p>
                )}
                {(item.conditions || item.preconditions) && (
                  <details>
                    <summary>适用前提</summary>
                    <pre>{readable(item.conditions || item.preconditions)}</pre>
                  </details>
                )}
                {item.steps && (
                  <details>
                    <summary>方法与步骤</summary>
                    <pre>{readable(item.steps)}</pre>
                  </details>
                )}
              </>
            )}
            <div className="record-actions">
              <button onClick={() => onEvidence(item)}>
                <FileText size={12} />
                来源
              </button>
              {['memory', 'relations'].includes(tab) && (
                <>
                  <button
                    disabled={['invalidated', 'forgotten', 'retired'].includes(item.status)}
                    aria-label={`纠正${item.title || item.name || '记忆'}`}
                    onClick={() => onCorrection(item)}
                  >
                    <Pencil size={12} />
                    纠正
                  </button>
                  <button
                    disabled={['invalidated', 'forgotten', 'retired'].includes(item.status)}
                    aria-label={`遗忘${item.title || item.name || '记忆'}`}
                    onClick={() => onForget(item)}
                  >
                    遗忘
                  </button>
                </>
              )}
              {tab === 'skills' && (
                <button
                  disabled={
                    ['draft', 'invalidated', 'forgotten', 'retired'].includes(item.status) ||
                    item.counterexamples?.length > 0 ||
                    item.unresolved?.length > 0
                  }
                  onClick={() => onStatus(item, item.status === 'active' ? 'suspended' : 'active')}
                >
                  {item.status === 'active'
                    ? '停用'
                    : item.status === 'draft'
                      ? '等待证据'
                      : item.status === 'invalidated'
                        ? '来源失效'
                        : item.status === 'retired'
                          ? '已退役'
                          : item.counterexamples?.length || item.unresolved?.length
                            ? '待处理反例'
                            : '重新启用'}
                </button>
              )}
              {tab === 'jobs' && item.status === 'failed' && (
                <button onClick={() => onRetry(item)}>
                  <RotateCcw size={12} />
                  重试
                </button>
              )}
            </div>
          </article>
        ))}
        {tab === 'memory' && !!snapshot?.memories.some((m) => m.kind === 'observation') && (
          <section className="observations">
            <details>
              <summary>
                长期观察 · {snapshot.memories.filter((m) => m.kind === 'observation').length}
              </summary>
              {snapshot.memories
                .filter((m) => m.kind === 'observation')
                .map((item) => (
                  <article className="observation-record" key={item.id}>
                    <p>{item.text}</p>
                    <button onClick={() => onEvidence(item)}>
                      <FileText size={12} />
                      展开原文证据
                    </button>
                  </article>
                ))}
            </details>
          </section>
        )}
        {tab === 'skills' && !!snapshot?.capabilities.length && (
          <section className="capabilities">
            <h3>角色能力</h3>
            <p className="quiet">角色能力与可复用经验分别记录。</p>
            {snapshot.capabilities.map((cap) => (
              <div key={cap.id}>
                <strong>
                  {ownerName(cap.actorId || cap.ownerId)} ·{' '}
                  {cap.capability || cap.name || cap.skill || '能力'}
                </strong>
                <p>
                  {statusName[cap.status] || cap.status}{' '}
                  {cap.data?.level ? ` · ${cap.data.level}` : ''}
                </p>
                <button onClick={() => onEvidence(cap)}>查看来源</button>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="inspector-footer">
        <button onClick={onRebuild} disabled={!snapshot} title="按当前分支有效原文重新整理记忆">
          <RotateCcw size={11} />
          重建记忆
        </button>
        <span className="mono">PROJECTION</span>
        <span className="mono">v{snapshot?.branch.projectionRevision || 0}</span>
      </div>
    </aside>
  );
}

function AuthorCorrectionModal({
  item,
  branchId,
  expectedHead,
  onClose,
  onSaved,
}: {
  item: Data;
  branchId: string;
  expectedHead: number;
  onClose: () => void;
  onSaved: (branchId: string) => Promise<void>;
}) {
  const target = useRef({ branchId, expectedHead });
  const attempt = useRef<{ text: string; commandId: string } | null>(null);
  return (
    <TextModal
      title={item.id ? '作者纠正' : '添加作者设定'}
      label={item.id ? '正确的信息' : '作者设定'}
      initial=""
      multiline
      description={
        item.id
          ? `纠正会记录为新事件并保留旧版本。原记忆：${textOf(item)}`
          : '将设定记录为独立作者事件，纳入此分支的世界事实。'
      }
      onClose={onClose}
      submit={async (text) => {
        if (!attempt.current || attempt.current.text !== text)
          attempt.current = { text, commandId: crypto.randomUUID() };
        await post(`/branches/${target.current.branchId}/corrections`, {
          text,
          commandId: attempt.current.commandId,
          expectedHead: target.current.expectedHead,
          ...(item.id ? { memoryId: item.id } : {}),
          ...(item.subjectId || item.subject ? { subjectId: item.subjectId || item.subject } : {}),
        });
        await onSaved(target.current.branchId);
      }}
    />
  );
}

function TextModal({
  title,
  label,
  initial,
  description,
  multiline = false,
  onClose,
  submit,
}: {
  title: string;
  label: string;
  initial: string;
  description: string;
  multiline?: boolean;
  onClose: () => void;
  submit: (text: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await submit(value.trim());
          } catch (error) {
            setError(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-content">
          <p className="modal-description">{description}</p>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <Field label={label}>
            {multiline ? (
              <textarea
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
                autoFocus
              />
            ) : (
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
                autoFocus
              />
            )}
          </Field>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy || !value.trim()}>
            {busy ? '保存中…' : '确认'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StoryModal({
  bootstrap,
  onClose,
  onCreate,
  onWorld,
  onAssets,
}: {
  bootstrap: Bootstrap;
  onClose: () => void;
  onCreate: (value: Data) => Promise<void>;
  onWorld: (name: string) => Promise<string>;
  onAssets: () => void;
}) {
  const [title, setTitle] = useState('');
  const [worldId, setWorldId] = useState(bootstrap.worlds[0]?.id || '');
  const [characters, setCharacters] = useState<string[]>([]);
  const [books, setBooks] = useState<string[]>([]);
  const [player, setPlayer] = useState('');
  const [newWorld, setNewWorld] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
  return (
    <Modal title="新建故事" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onCreate({
              worldId: worldId || bootstrap.worlds[0]?.id,
              title: title.trim(),
              characterIds: characters,
              worldbookIds: books,
              ...(player ? { playerCharacterId: player } : {}),
            });
          } catch (error) {
            setError(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-content">
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <Field label="故事标题">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="为下一段故事取个名字"
              required
              autoFocus
            />
          </Field>
          <Field label="所属世界">
            <select value={worldId} onChange={(event) => setWorldId(event.target.value)}>
              {bootstrap.worlds.map((world) => (
                <option key={world.id} value={world.id}>
                  {world.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="new-world-inline">
            <input
              aria-label="新世界名称"
              value={newWorld}
              onChange={(event) => setNewWorld(event.target.value)}
              placeholder="或创建一个新世界…"
            />
            <button
              type="button"
              disabled={!newWorld.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const id = await onWorld(newWorld.trim());
                  setWorldId(id);
                  setNewWorld('');
                } catch (error) {
                  setError(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              创建世界
            </button>
          </div>
          <div className="selection-group">
            <h3>
              角色 <small>可多选</small>
            </h3>
            {bootstrap.assets
              .filter((a) => a.kind === 'character')
              .map((asset) => (
                <label key={asset.id} className="selection-row">
                  <input
                    type="checkbox"
                    checked={characters.includes(asset.id)}
                    onChange={() => setCharacters(toggle(characters, asset.id))}
                  />
                  <span>{characterName(asset)}</span>
                  <Badge subtle>v{asset.revision}</Badge>
                </label>
              ))}
            {!bootstrap.assets.some((a) => a.kind === 'character') && (
              <div className="selection-empty">
                <p>还没有角色卡。你可以先创建资料，再开始故事。</p>
                <button type="button" onClick={onAssets}>
                  <Plus size={14} />
                  创建角色卡
                </button>
              </div>
            )}
          </div>
          <div className="selection-group">
            <h3>
              世界书 <small>可多选</small>
            </h3>
            {bootstrap.assets
              .filter((a) => a.kind === 'worldbook')
              .map((asset) => (
                <label key={asset.id} className="selection-row">
                  <input
                    type="checkbox"
                    checked={books.includes(asset.id)}
                    onChange={() => setBooks(toggle(books, asset.id))}
                  />
                  <span>{characterName(asset)}</span>
                  <Badge subtle>v{asset.revision}</Badge>
                </label>
              ))}
            {!bootstrap.assets.some((a) => a.kind === 'worldbook') && (
              <p className="quiet">没有世界书。可以先开始一个空白世界。</p>
            )}
          </div>
          {characters.length > 0 && (
            <Field label="玩家角色">
              <select value={player} onChange={(event) => setPlayer(event.target.value)}>
                <option value="">自由视角</option>
                {bootstrap.assets
                  .filter((a) => characters.includes(a.id))
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {characterName(asset)}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <p className="quiet">
            故事固定使用所选资料的当前版本，后续编辑不会悄悄改变已发生的剧情。
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            type="submit"
            disabled={busy || !title.trim() || !bootstrap.worlds.length}
          >
            {busy ? '创建中…' : '创建故事'}
            <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
