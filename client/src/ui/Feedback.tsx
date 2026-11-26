// 加载、空、错误、撤销条、提示、离线、进度（06 第 17 节）。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorText, useUndo } from '../api/hooks';
import { useReducedMotion } from '../lib/motion';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Button } from './Button';
import css from './feedback.module.css';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Text } from './Text';

export function Skeleton({ width = '100%', height = 16, radius = 8, circle }: { width?: number | string; height?: number; radius?: number; circle?: boolean }) {
  return <span className={css.skel} style={{ width: circle ? height : width, height, borderRadius: circle ? '50%' : radius }} aria-hidden />;
}

/** 超过 3 秒仍在加载时加一行说明（H6） */
export function Loading({ children, label = s.state.loading }: { children: ReactNode; label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div role="status" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {children}
      {slow && <Text variant="caption" tone="tertiary" center>{s.state.slow}</Text>}
    </div>
  );
}

export function EmptyState({ icon = 'info', title, action }: { icon?: IconName; title: string; action?: ReactNode }) {
  return (
    <div className={css.state}>
      <span className={css.stateIcon}><Icon name={icon} size={24} /></span>
      <Text tone="secondary">{title}</Text>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, action }: { error: unknown; onRetry?: () => void; action?: ReactNode }) {
  return (
    <div className={css.state} role="alert">
      <span className={css.stateIcon}><Icon name="warning" size={24} /></span>
      <Text tone="secondary">{errorText(error)}</Text>
      {action ?? (onRetry && <Button variant="secondary" icon="retry" onClick={onRetry}>{s.action.retry}</Button>)}
    </div>
  );
}

/** 底部撤销条，5 秒；新的替换旧的（H4） */
export function UndoBar() {
  const undo = useUi((st) => st.undo);
  const toasts = useUi((st) => st.toasts);
  const clear = useUi((st) => st.clearUndo);
  const dismiss = useUi((st) => st.dismissToast);
  const run = useUndo();
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(clear, 5000);
    return () => clearTimeout(t);
  }, [undo, clear]);
  return (
    <div className={css.dock} aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`${css.toast} ${t.tone === 'danger' ? css.toastDanger : ''}`} role={t.tone === 'danger' ? 'alert' : 'status'} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
      {undo && (
        <div key={undo.key} className={css.undo}>
          <span>{undo.label}</span>
          <button type="button" onClick={() => { run.mutate(undo.id); clear(); }}>{s.action.undo}</button>
          <span className={css.undoTimer} aria-hidden />
        </div>
      )}
    </div>
  );
}

export function OfflineBar() {
  const offline = useUi((st) => st.offline);
  if (!offline) return null;
  return <div className={css.offline} role="status"><Icon name="offline" size={16} />{s.state.offline}</div>;
}

export function ProgressBar({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <div className={css.bar} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className={css.barFill} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </div>
  );
}

/** 进度环（ArkUI Progress Ring）：今日进度、准备度 */
export function Ring({ value, size = 56, stroke = 6, color = 'var(--accent)', children, label }: {
  value: number; size?: number; stroke?: number; color?: string; children?: ReactNode; label: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className={css.ring} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} aria-hidden>
        <circle className={css.ringTrack} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        <circle className={css.ringFill} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} />
      </svg>
      {children && <div className={css.ringLabel}>{children}</div>}
    </div>
  );
}

/** 大号数字：从 from 滚到 value，800ms（M4）；减少动态效果时直接显示终值 */
export function BigNumber({ value, unit, from = 0, animate = true, size = 'display' }: { value: number; unit?: string; from?: number; animate?: boolean; size?: 'display' | 'h1' }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(animate && !reduce ? from : value);
  const raf = useRef(0);
  useEffect(() => {
    if (!animate || reduce) { setShown(value); return; }
    const start = performance.now();
    const begin = from;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 800);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(begin + (value - begin) * eased));
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, from, animate, reduce]);
  return (
    <span className={css.big} style={size === 'h1' ? { fontSize: 'var(--fs-h1)', lineHeight: 'var(--lh-h1)' } : undefined}>
      {shown}
      {unit && <span className={css.bigUnit}>{unit}</span>}
    </span>
  );
}
