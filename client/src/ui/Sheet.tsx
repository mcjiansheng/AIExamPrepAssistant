// 弹层（bindSheet）、确认框（AlertDialog，只用于不可逆操作）、菜单（Menu）。
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import type { IconName } from './icons';
import css from './surfaces.module.css';
import { Text } from './Text';

function useFocusReturn(open: boolean) {
  const previous = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement;
    return () => {
      if (previous.current instanceof HTMLElement) previous.current.focus();
    };
  }, [open]);
}

export function Sheet({ open, onClose, title, children, footer, size = 'auto', wide, label }: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'auto' | 'full';
  wide?: boolean;
  label?: string;
}) {
  const bp = useBreakpoint();
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useFocusReturn(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, button:not([data-close]), [href], [tabindex]:not([tabindex="-1"])');
    first?.focus({ preventScroll: true });
    const body = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = body;
    };
  }, [open, onClose]);
  if (!open) return null;
  const compact = isCompact(bp);
  // 门户里的事件仍会沿 React 树冒泡；拦住，免得触发外层卡片的链接
  return createPortal(
    <div onClick={(e) => e.stopPropagation()}>
      <div className={css.scrim} onClick={onClose} aria-hidden />
      <div className={cx(css.sheetWrap, !compact && css.center)}>
        <div ref={ref} className={cx(css.sheet, size === 'full' && css.full, wide && css.wide)} role="dialog" aria-modal="true" aria-labelledby={title ? id : undefined} aria-label={title ? undefined : label}>
          {compact && <div className={css.handle} aria-hidden />}
          {(title || compact) && (
            <div className={css.sheetHead}>
              <div id={id} className={css.sheetTitle}>{title}</div>
              <span data-close><IconButton icon="close" label={s.action.close} onClick={onClose} /></span>
            </div>
          )}
          <div className={css.sheetBody}>{children}</div>
          {footer && <div className={css.sheetFoot}>{footer}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, title, body, confirm, cancel = s.action.cancel, danger, onConfirm, onCancel, loading }: {
  open: boolean; title: string; body: ReactNode; confirm: string; cancel?: string; danger?: boolean; loading?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Sheet open={open} onClose={onCancel} title={title} footer={
      <>
        <Button variant="neutral" onClick={onCancel}>{cancel}</Button>
        <Button variant={danger ? 'dangerSolid' : 'primary'} onClick={onConfirm} loading={loading}>{confirm}</Button>
      </>
    }>
      <Text tone="secondary">{body}</Text>
    </Sheet>
  );
}

export interface MenuItem { label: string; icon?: IconName; danger?: boolean; onSelect: () => void }

export function Menu({ items, label = s.action.more, note, icon = 'more', openKey = 0 }: {
  items: MenuItem[]; label?: string; note?: string; icon?: IconName;
  /** 变化时打开菜单（长按触发） */
  openKey?: number;
}) {
  const bp = useBreakpoint();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (openKey) setOpen(true); }, [openKey]);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || isCompact(bp)) return;
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 260), right: Math.max(8, window.innerWidth - r.right) });
  }, [open, bp]);
  useEffect(() => {
    if (!open || isCompact(bp)) return;
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    menu.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, bp]);
  const choose = (item: MenuItem) => { setOpen(false); item.onSelect(); };
  return (
    <>
      <span ref={trigger} onClick={(e) => e.preventDefault()}>
        <IconButton icon={icon} label={label} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }} size="sm" />
      </span>
      {open && isCompact(bp) && (
        <Sheet open onClose={() => setOpen(false)} label={label}>
          {note && <Text variant="bodySm" tone="secondary">{note}</Text>}
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 8 }} role="menu" aria-label={label}>
            {items.map((item) => (
              <button key={item.label} type="button" role="menuitem" className={cx(css.menuItem, item.danger && css.menuItemDanger)} style={{ minHeight: 52, fontSize: 'var(--fs-body)' }} onClick={() => choose(item)}>
                {item.icon && <Icon name={item.icon} />}{item.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {open && !isCompact(bp) && pos && createPortal(
        <div ref={menu} className={css.menu} style={{ top: pos.top, right: pos.right }} role="menu" aria-label={label} onClick={(e) => e.stopPropagation()}>
          {note && <div className={css.menuItemNote}>{note}</div>}
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={cx(css.menuItem, item.danger && css.menuItemDanger)} onClick={(e) => { e.stopPropagation(); choose(item); }}>
              {item.icon && <Icon name={item.icon} size={18} />}{item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
