import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = () =>
      ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    if (!ref.current?.contains(document.activeElement)) first();
    const handler = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"]')).at(-1) !== ref.current) return;
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const focusable = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]',
          ) || [],
        );
        const firstElement = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          firstElement?.focus();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">+</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        'aria-label': label,
        'aria-describedby': hint ? id : undefined,
      })
    : children;
  return (
    <label className="field">
      <span>{label}</span>
      {control}
      {hint && <small id={id}>{hint}</small>}
    </label>
  );
}
export function Badge({ children, subtle = false }: { children: ReactNode; subtle?: boolean }) {
  return <span className={`badge ${subtle ? 'subtle' : ''}`}>{children}</span>;
}
export const statusName: Record<string, string> = {
  active: '有效',
  draft: '待验证',
  invalidated: '已失效',
  retired: '已退役',
  available: '可用',
  lost: '已失去',
  uncertain: '待确认',
  candidate: '待验证',
  suspended: '已停用',
  rejected: '已拒绝',
  superseded: '已替代',
  deleted: '已删除',
  forgotten: '已遗忘',
  success: '成功',
  succeeded: '已完成',
  failure: '失败',
  failed: '失败',
  partial: '部分完成',
  unknown: '待确认',
  unfinished: '未完成',
  running: '处理中',
  queued: '排队中',
  pending: '待处理',
  completed: '已完成',
  complete: '已完成',
  cancelled: '已取消',
  canceled: '已取消',
  applied: '已使用',
  planned: '拟使用',
  committed: '已提交',
};
