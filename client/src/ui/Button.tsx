// 按钮（ArkUI Button）：主按钮实心胶囊，一页最多一个（H1）；次按钮浅色填充；文字按钮。
import type { MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../lib/cx';
import css from './controls.module.css';
import { Icon } from './Icon';
import type { IconName } from './icons';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'neutral' | 'text' | 'danger' | 'dangerSolid';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
  to?: string;
  /** 共享元素过渡（M1） */
  viewTransition?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  children?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, loading, disabled, block, type = 'button', to, viewTransition, onClick, children, ...aria }: ButtonProps) {
  const className = cx(css.btn, css[`btn-${variant}`], size !== 'md' && css[`btn-${size}`], block && css['btn-block']);
  const inner = (
    <>
      {loading && <span className={cx(css.spinner, css.spin)} aria-hidden />}
      {icon && <span className={loading ? css.hidden : undefined}><Icon name={icon} size={size === 'sm' ? 16 : 18} /></span>}
      {children && <span className={loading ? css.hidden : undefined}>{children}</span>}
      {iconRight && <span className={loading ? css.hidden : undefined}><Icon name={iconRight} size={16} /></span>}
    </>
  );
  if (to && !disabled) {
    return <Link to={to} viewTransition={viewTransition} className={className} aria-label={aria['aria-label']}>{inner}</Link>;
  }
  return (
    <button type={type} className={className} disabled={disabled || loading} onClick={onClick} aria-busy={loading || undefined} {...aria}>
      {inner}
    </button>
  );
}

export function IconButton({ icon, label, onClick, to, variant = 'plain', size = 'md', disabled, badge, pressed }: {
  icon: IconName;
  label: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  to?: string;
  variant?: 'plain' | 'filled' | 'accent';
  size?: 'sm' | 'md';
  disabled?: boolean;
  badge?: boolean;
  pressed?: boolean;
}) {
  const className = cx(css.iconBtn, variant !== 'plain' && css[`iconBtn-${variant}`], size === 'sm' && css['iconBtn-sm']);
  const glyph = (
    <span style={{ position: 'relative', display: 'grid' }}>
      <Icon name={icon} size={size === 'sm' ? 18 : 20} />
      {badge && <span className={css.badgeDot} style={{ position: 'absolute', top: -2, right: -3 }} />}
    </span>
  );
  if (to) return <Link to={to} className={className} aria-label={label} title={label}>{glyph}</Link>;
  return <button type="button" className={className} aria-label={label} title={label} onClick={onClick} disabled={disabled} aria-pressed={pressed}>{glyph}</button>;
}
