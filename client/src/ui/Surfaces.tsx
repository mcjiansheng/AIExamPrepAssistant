// 分组容器（List + ListItemGroup）、列表项（ListItem）、卡片（自定义组件，带按下态）。
import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx } from '../lib/cx';
import { Icon } from './Icon';
import type { IconName } from './icons';
import css from './surfaces.module.css';
import { Text } from './Text';

export function Group({ title, action, children, padded, highlight }: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  /** 被助手或撤销改动后高亮一次（M7） */
  highlight?: number | null;
}) {
  return (
    <section>
      {(title || action) && (
        <div className={css.groupHead}>
          {title && <Text variant="bodySm" tone="secondary" as="h2" strong>{title}</Text>}
          {action}
        </div>
      )}
      <div className={cx(css.group, padded && css.groupPad, highlight ? css.highlight : undefined)} key={highlight ?? undefined}>{children}</div>
    </section>
  );
}

export interface ListItemProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  iconTone?: 'accent' | 'neutral' | 'danger' | 'warning' | 'success';
  leading?: ReactNode;
  value?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  to?: string;
  onClick?: () => void;
  danger?: boolean;
  label?: string;
}

const ICON_TONE = {
  accent: undefined,
  neutral: { background: 'var(--bg-sunken)', color: 'var(--text-secondary)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
  warning: { background: 'var(--warning-soft)', color: 'var(--warning)' },
  success: { background: 'var(--success-soft)', color: 'var(--success)' },
};

export function ListItem({ title, subtitle, icon, iconTone = 'accent', leading, value, trailing, chevron, to, onClick, danger, label }: ListItemProps) {
  const pressable = !!(to || onClick);
  const body = (
    <>
      {icon && <span className={css.itemIcon} style={ICON_TONE[iconTone]}><Icon name={icon} size={18} /></span>}
      {leading}
      <span className={css.itemBody}>
        <span className={css.itemTitle}>{title}</span>
        {subtitle && <span className={css.itemSub}>{subtitle}</span>}
      </span>
      {value !== undefined && <span className={css.itemValue}>{value}</span>}
      {trailing}
      {(chevron ?? !!to) && <Icon name="chevronRight" size={18} tone="tertiary" />}
    </>
  );
  const className = cx(css.item, pressable && css.itemPress, (icon || leading) && css.withIcon, danger && css.itemDanger);
  if (to) return <Link to={to} className={className} aria-label={label}>{body}</Link>;
  if (onClick) return <button type="button" className={className} onClick={onClick} aria-label={label}>{body}</button>;
  return <div className={className}>{body}</div>;
}

export function Card({ children, to, onClick, color, tone = 'surface', transitionName, label, highlight, flat, viewTransition }: {
  children: ReactNode;
  to?: string;
  onClick?: () => void;
  /** 课程色条 */
  color?: number;
  tone?: 'surface' | 'sunken' | 'tinted';
  /** 共享元素过渡的名字（M1） */
  transitionName?: string;
  label?: string;
  highlight?: number | null;
  flat?: boolean;
  viewTransition?: boolean;
}) {
  const className = cx(css.card, (to || onClick) && css.cardPress, tone === 'sunken' && css.cardSunken, tone === 'tinted' && css.cardTinted, flat && css.cardFlat, highlight ? css.highlight : undefined);
  const style = transitionName ? { viewTransitionName: transitionName } : undefined;
  const strip = color !== undefined ? <span className={css.strip} style={{ background: `var(--course-${color % 8})` }} aria-hidden /> : null;
  if (to) return <Link to={to} viewTransition={viewTransition} className={className} style={style} aria-label={label} key={highlight ?? undefined}>{strip}{children}</Link>;
  if (onClick) return <button type="button" className={className} style={style} onClick={onClick} aria-label={label} key={highlight ?? undefined}>{strip}{children}</button>;
  return <div className={className} style={style} key={highlight ?? undefined}>{strip}{children}</div>;
}
