// 胶囊（选择、筛选、快捷指令）与标签（状态、级别）。
import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import css from './controls.module.css';
import { Icon } from './Icon';
import type { IconName } from './icons';

export function Chip({ children, selected, outline, icon, onClick, label }: {
  children: ReactNode;
  selected?: boolean;
  outline?: boolean;
  icon?: IconName;
  onClick?: () => void;
  label?: string;
}) {
  return (
    <button type="button" className={cx(css.chip, selected && css['chip-selected'], outline && css['chip-outline'])} aria-pressed={selected} onClick={onClick} aria-label={label}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

export type TagTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'success' | 'strong';
export function Tag({ children, tone = 'neutral', icon }: { children: ReactNode; tone?: TagTone; icon?: IconName }) {
  return (
    <span className={cx(css.tag, css[`tag-${tone}`])}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  );
}

export function Badge({ count, dot }: { count?: number; dot?: boolean }) {
  if (dot) return <span className={css.badgeDot} aria-hidden />;
  if (!count) return null;
  return <span className={css.badge}>{count > 99 ? '99+' : count}</span>;
}

export function ColorDot({ color, size = 10 }: { color: number; size?: number }) {
  return <span className={css.colorDot} style={{ background: `var(--course-${color % 8})`, width: size, height: size }} aria-hidden />;
}

export function Spinner({ label }: { label?: string }) {
  return <span className={css.spinner} role={label ? 'status' : undefined} aria-label={label} />;
}

export function Avatar({ name, size = 56 }: { name: string; size?: number }) {
  return <span className={css.avatar} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>{name.slice(0, 1)}</span>;
}
