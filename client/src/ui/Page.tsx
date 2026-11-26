// 页面骨架（NavDestination）：页头 + 内容。一级页面用大标题；推入的页面是“返回 + 标题 + 图标按钮”（10 第 4.2 节）。
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { cx } from '../lib/cx';
import { useBreakpoint, type Breakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import { IconButton } from './Button';
import css from './page.module.css';

export function Page({ title, subtitle, back, actions, children, width = 'content', large, titleTransition, headerless }: {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** 返回的目标；true 表示返回上一页 */
  back?: string | true;
  actions?: ReactNode;
  children: ReactNode;
  width?: 'content' | 'reading' | 'full';
  large?: boolean;
  titleTransition?: string;
  headerless?: boolean;
}) {
  const navigate = useNavigate();
  const goBack = () => {
    if (back === true || (typeof back === 'string' && window.history.state?.idx > 0)) navigate(-1);
    else if (typeof back === 'string') navigate(back, { replace: true });
  };
  return (
    <div className={css.page}>
      <div className={cx(css.inner, css[width])}>
        {!headerless && (
          <header className={cx(css.head, large ? css.large : css.sticky)}>
            {back && <IconButton icon="back" label={s.action.back} onClick={goBack} />}
            <div className={css.titleBox} style={titleTransition ? { viewTransitionName: titleTransition } : undefined}>
              {title && <h1 className={cx(css.title, !large && css.titleSmall)}>{title}</h1>}
              {subtitle && <div className={css.sub}>{subtitle}</div>}
            </div>
            {actions && <div className={css.actions}>{actions}</div>}
          </header>
        )}
        {children}
      </div>
    </div>
  );
}

export function Section({ title, action, children, id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className={css.section} aria-labelledby={id}>
      {(title || action) && (
        <div className={css.sectionHead}>
          {title && <h2 id={id} className={css.sectionTitle}>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * 分栏：手机上纵向堆叠；md 及以上按比例并排（主从双栏）。
 * 并排还要看内容区的实际宽度：助手面板常驻时内容区变窄，放不下两栏就仍纵向排。
 */
export function Split({ main, side, ratio = '3fr 2fr', from = 'md', stickySide, reverse, minWidth = 720 }: {
  main: ReactNode; side: ReactNode; ratio?: string; from?: Breakpoint; stickySide?: boolean; reverse?: boolean; minWidth?: number;
}) {
  const bp = useBreakpoint();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const order: Breakpoint[] = ['xs', 'sm', 'md', 'lg', 'xl'];
  const split = order.indexOf(bp) >= order.indexOf(from) && width >= minWidth;
  // 纵向排时主内容总在前；reverse 只决定并排时谁在左
  return <div ref={box} style={{ minWidth: 0 }}>{split ? <SplitGrid {...{ main, side, ratio, stickySide, reverse }} /> : <div className={css.pane}>{main}{side}</div>}</div>;
}

function SplitGrid({ main, side, ratio, stickySide, reverse }: { main: ReactNode; side: ReactNode; ratio: string; stickySide?: boolean; reverse?: boolean }) {
  return (
    <div className={css.split} style={{ gridTemplateColumns: reverse ? ratio.split(' ').reverse().join(' ') : ratio }}>
      {reverse ? (
        <>
          <div className={cx(css.pane, stickySide && css.stickyPane)}>{side}</div>
          <div className={css.pane}>{main}</div>
        </>
      ) : (
        <>
          <div className={css.pane}>{main}</div>
          <div className={cx(css.pane, stickySide && css.stickyPane)}>{side}</div>
        </>
      )}
    </div>
  );
}
