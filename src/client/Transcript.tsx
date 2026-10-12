import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, BookOpen, ShieldCheck, UserRound } from 'lucide-react';

/** Follow the viewport's previous position, before incoming content changes its height. */
export default function Transcript({
  scope,
  ready,
  older,
  revision,
  followRequest,
  children,
}: {
  scope: string;
  ready: boolean;
  older: boolean;
  revision: string;
  followRequest: number;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const previous = useRef<{ scope: string; revision: string; followRequest: number } | null>(null);
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false);
  const latest = () => {
    following.current = true;
    setAway(false);
    setUnread(false);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  const onScroll = () => {
    const node = viewport.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 48;
    following.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnread(false);
  };
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !ready) return;
    const last = previous.current;
    if (!last || last.scope !== scope) {
      following.current = !older;
      node.scrollTop = older ? 0 : node.scrollHeight;
      setAway(older && node.scrollHeight > node.clientHeight + 48);
      setUnread(false);
    } else if (!older && (last.followRequest !== followRequest || following.current)) {
      latest();
    } else if (last.revision !== revision && !older) {
      setUnread(true);
    }
    previous.current = { scope, revision, followRequest };
  }, [scope, ready, older, revision, followRequest]);
  useEffect(() => {
    const node = viewport.current,
      body = content.current;
    if (!node || !body || !ready) return;
    // Keep the bottom anchored when wrapping, fonts or the inspector change size.
    const observer = new ResizeObserver(() => {
      if (following.current) node.scrollTop = node.scrollHeight;
      else if (node.scrollHeight - node.scrollTop - node.clientHeight <= 48) {
        following.current = true;
        setAway(false);
        setUnread(false);
      }
    });
    observer.observe(node);
    observer.observe(body);
    return () => observer.disconnect();
  }, [scope, ready]);
  return (
    <div className="transcript-viewport">
      <div
        className="transcript"
        ref={viewport}
        onScroll={onScroll}
        onClickCapture={(event) => {
          // Opening a saved draft is a reading action, not a request to follow its end.
          if (event.target instanceof Element && event.target.closest('summary')) {
            following.current = false;
            setAway(true);
          }
        }}
        tabIndex={0}
        aria-label="故事正文"
      >
        <div className="transcript-content" ref={content}>
          {children}
        </div>
      </div>
      {away && !older && (
        <button className={`jump-to-latest ${unread ? 'has-unread' : ''}`} onClick={latest}>
          <ArrowDownToLine size={14} />
          {unread ? '有新内容 · 回到最新' : '回到最新'}
        </button>
      )}
    </div>
  );
}
export type SenderKind = 'player' | 'ai' | 'author' | 'system';
export function SenderLabel({
  kind,
  name,
  detail,
}: {
  kind: SenderKind;
  name?: string;
  detail?: string;
}) {
  const Icon = kind === 'player' ? UserRound : kind === 'ai' ? BookOpen : ShieldCheck;
  const label =
    name || { player: '你', ai: 'AI 叙事', author: '作者设定', system: '系统记录' }[kind];
  return (
    <span className={`message-sender sender-${kind}`}>
      <span className="sender-avatar" aria-hidden="true">
        <Icon size={15} />
      </span>
      <strong>{label}</strong>
      {detail && <span className="sender-detail">{detail}</span>}
    </span>
  );
}
export function senderKind(role: string): SenderKind {
  return ['assistant', 'narrator'].includes(role)
    ? 'ai'
    : ['author', 'correction'].includes(role)
      ? 'author'
      : role === 'user'
        ? 'player'
        : 'system';
}
