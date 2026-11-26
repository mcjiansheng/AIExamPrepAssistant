// 布局原语：名字和参数对齐 ArkUI（Row / Column / Stack / GridRow / Blank / Divider / Scroll），转换时逐行替换（08 第 1.3 节）。
// 间距只能取 4 的倍数的刻度；业务代码只用这些原语和 ui/ 组件，不直接写 div 加样式。
import { createElement, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import { useBreakpoint, type Breakpoint } from '../state/breakpoint';
import css from './layout.module.css';

export type Space = 0 | 2 | 4 | 8 | 12 | 16 | 24 | 32 | 48;
type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
type Justify = 'start' | 'center' | 'end' | 'between' | 'around';
type Tag = 'div' | 'section' | 'header' | 'footer' | 'nav' | 'main' | 'aside' | 'ul' | 'li' | 'ol' | 'article' | 'form' | 'label' | 'span';

interface BoxProps {
  gap?: Space;
  padding?: Space | [Space, Space];
  align?: Align;
  justify?: Justify;
  wrap?: boolean;
  grow?: boolean;
  shrink?: boolean;
  width?: 'fill' | number;
  maxWidth?: number;
  minWidth?: number;
  as?: Tag;
  className?: string;
  id?: string;
  role?: string;
  'aria-label'?: string;
  'aria-live'?: 'polite' | 'off';
  onSubmit?: (e: React.FormEvent) => void;
  children?: ReactNode;
}

const ALIGN: Record<Align, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' };
const JUSTIFY: Record<Justify, string> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };

function boxStyle(p: BoxProps, direction: 'row' | 'column'): CSSProperties {
  return {
    display: 'flex',
    flexDirection: direction,
    gap: p.gap,
    padding: Array.isArray(p.padding) ? `${p.padding[0]}px ${p.padding[1]}px` : p.padding,
    alignItems: p.align ? ALIGN[p.align] : direction === 'row' ? 'center' : undefined,
    justifyContent: p.justify ? JUSTIFY[p.justify] : undefined,
    flexWrap: p.wrap ? 'wrap' : undefined,
    flex: p.grow ? '1 1 0' : undefined,
    flexShrink: p.shrink === false ? 0 : undefined,
    minWidth: p.minWidth ?? (p.grow ? 0 : undefined),
    width: p.width === 'fill' ? '100%' : p.width,
    maxWidth: p.maxWidth,
  };
}

function box(direction: 'row' | 'column') {
  return function Box({ as = 'div', className, children, id, role, onSubmit, ...rest }: BoxProps) {
    return createElement(as, {
      className, id, role, onSubmit, style: boxStyle(rest, direction),
      'aria-label': rest['aria-label'], 'aria-live': rest['aria-live'],
    }, children);
  };
}

/** 横向排列（ArkUI Row） */
export const Row = box('row');
/** 纵向排列（ArkUI Column） */
export const Column = box('column');

/** 层叠（ArkUI Stack）：子元素占同一格，按 align 对齐 */
export function Stack({ children, align = 'center', className }: { children: ReactNode; align?: 'center' | 'start' | 'end'; className?: string }) {
  return <div className={cx(css.stack, className)} style={{ placeItems: align }}>{children}</div>;
}

/** 弹性空白（ArkUI Blank） */
export function Spacer() {
  return <div className={css.spacer} aria-hidden />;
}

/** 分隔线（ArkUI Divider） */
export function Divider({ inset = 0, vertical = false }: { inset?: Space; vertical?: boolean }) {
  return <div className={vertical ? css.vline : css.line} style={vertical ? undefined : { marginLeft: inset }} role="separator" />;
}

/** 栅格（ArkUI GridRow / GridCol）：按断点给列数 */
export function Grid({ columns = 1, gap = 12, children, className, minItem }: {
  columns?: number | Partial<Record<Breakpoint, number>>;
  gap?: Space;
  children: ReactNode;
  className?: string;
  /** 自适应：每项最小宽度，放得下几列就几列 */
  minItem?: number;
}) {
  const bp = useBreakpoint();
  let n = typeof columns === 'number' ? columns : 1;
  if (typeof columns === 'object') {
    const order: Breakpoint[] = ['xs', 'sm', 'md', 'lg', 'xl'];
    for (const b of order.slice(0, order.indexOf(bp) + 1)) n = columns[b] ?? n;
  }
  const template = minItem ? `repeat(auto-fill, minmax(${minItem}px, 1fr))` : `repeat(${n}, minmax(0, 1fr))`;
  return <div className={cx(css.grid, className)} style={{ gridTemplateColumns: template, gap }}>{children}</div>;
}

/** 滚动容器（ArkUI Scroll） */
export function Scroll({ children, axis = 'y', className, label }: { children: ReactNode; axis?: 'x' | 'y'; className?: string; label?: string }) {
  return <div className={cx(axis === 'x' ? css.scrollX : css.scrollY, className)} aria-label={label} role={label ? 'region' : undefined}>{children}</div>;
}
