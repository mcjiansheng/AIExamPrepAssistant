// 知识点地图：全产品的视觉主线（07 第 6 节）。对应 ArkUI 的自定义组件（Grid），缩略图用 Canvas。
import { useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import type { KpState, Level, MapCell, MapChapter } from '../api/types';
import { cx } from '../lib/cx';
import { stagger } from '../lib/motion';
import { useBreakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import css from './map.module.css';
import { Text } from './Text';

export function cellLabel(kp: Pick<MapCell, 'title' | 'state' | 'level'>) {
  const parts = [kp.title, s.kpState[kp.state]];
  if (kp.level === 'emphasized' || kp.level === 'conflict') parts.push('老师强调');
  if (kp.level === 'excluded') parts.push('不考');
  return parts.join('，');
}

export function cellClass(state: KpState, level: Level, current?: boolean) {
  return cx(
    css.cell,
    state === 'learned' && css.learned,
    state === 'shaky' && css.shaky,
    state === 'mastered' && css.mastered,
    (level === 'emphasized' || level === 'conflict') && css.emphasis,
    level === 'excluded' && css.excluded,
    current && css.current,
  );
}

interface MapProps {
  chapters: MapChapter[];
  courseId: string;
  current?: string | null;
  changed?: string[];
  organizing?: boolean;
  /** 只显示格子，不显示章节标题 */
  bare?: boolean;
  big?: boolean;
  columns?: 1 | 2 | 3;
}

export function KnowledgeMap({ chapters, courseId, current, changed = [], organizing, bare, big, columns = 1 }: MapProps) {
  const navigate = useNavigate();
  const bp = useBreakpoint();
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const changedOrder = new Map(changed.map((id, i) => [id, i]));
  const show = (el: HTMLElement, kp: MapCell) => {
    const root = box.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (root) setTip({ text: `${kp.title} · ${s.kpState[kp.state]}`, x: r.left - root.left + r.width / 2, y: r.top - root.top });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 };
    const delta = keys[e.key];
    if (delta === undefined) return;
    const cells = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const i = cells.indexOf(document.activeElement as HTMLButtonElement);
    const next = cells[Math.max(0, Math.min(cells.length - 1, i + delta))];
    if (next) { e.preventDefault(); next.focus(); }
  };
  const cols = bp === 'xs' || bp === 'sm' ? 1 : columns;
  return (
    <div className={cx(css.map, big && css.big)} ref={box} onPointerLeave={() => setTip(null)}>
      <div className={css.chapters} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {chapters.map((ch) => (
          <section key={ch.id} className={css.chapter} aria-label={`${ch.title}，已掌握 ${ch.mastered}/${ch.total}`}>
            {!bare && (
              <div className={css.chapterHead}>
                <Text variant="bodySm" tone="secondary" nowrap>{ch.title}</Text>
                <Text variant="caption" tone="tertiary" as="span">{ch.mastered}/{ch.total}</Text>
              </div>
            )}
            <div className={css.cells} role="group" onKeyDown={onKey}>
              {ch.kps.map((kp, i) => {
                const order = changedOrder.get(kp.id);
                return (
                  <button
                    key={kp.id}
                    type="button"
                    className={cx(cellClass(kp.state, kp.level, kp.id === current), order !== undefined && css.pulse)}
                    style={order !== undefined ? { animationDelay: stagger(order, changed.length) } : undefined}
                    aria-label={cellLabel(kp)}
                    tabIndex={i === 0 || kp.id === current ? 0 : -1}
                    onClick={() => navigate(`/c/${courseId}/kp/${kp.id}`)}
                    onPointerEnter={(e) => show(e.currentTarget, kp)}
                    onFocus={(e) => show(e.currentTarget, kp)}
                    onBlur={() => setTip(null)}
                  />
                );
              })}
            </div>
          </section>
        ))}
        {organizing && <MapSkeleton />}
      </div>
      {tip && <div className={css.tip} style={{ left: tip.x, top: tip.y }} role="tooltip">{tip.text}</div>}
    </div>
  );
}

export function MapSkeleton({ count = 24 }: { count?: number }) {
  return (
    <section className={css.chapter} aria-label={s.course.organizing}>
      <div className={css.cells}>
        {Array.from({ length: count }, (_, i) => <span key={i} className={cx(css.cell, css.skeleton)} style={{ animationDelay: `${(i % 8) * 90}ms` }} />)}
      </div>
    </section>
  );
}

const FILL: Record<KpState, string> = { new: 'transparent', learned: 'transparent', shaky: 'var(--mastery-shaky)', mastered: 'var(--mastery-mastered)' };

/** 缩略图：课程卡、页头用。整体可点，不响应单格（07 第 6 节） */
export function MiniMap({ chapters, cell = 7, gap = 2, perRow = 24, current, label }: {
  chapters: MapChapter[]; cell?: number; gap?: number; perRow?: number; current?: string | null; label: string;
}) {
  const cells = chapters.flatMap((c) => c.kps);
  const rows = Math.max(1, Math.ceil(cells.length / perRow));
  const width = Math.min(cells.length, perRow) * (cell + gap) - gap;
  const height = rows * (cell + gap) - gap;
  const r = cell * 0.25;
  return (
    <svg className={css.mini} width={Math.max(width, cell)} height={height} role="img" aria-label={label}>
      {cells.map((kp, i) => {
        const x = (i % perRow) * (cell + gap);
        const y = Math.floor(i / perRow) * (cell + gap);
        const excluded = kp.level === 'excluded';
        const stroke = kp.state === 'shaky' ? 'var(--mastery-shaky)' : kp.state === 'mastered' ? 'var(--mastery-mastered)' : 'var(--mastery-new)';
        return (
          <g key={kp.id} opacity={excluded ? 0.35 : 1}>
            {kp.state === 'shaky' ? (
              <>
                <rect x={x + 0.5} y={y + 0.5} width={cell - 1} height={cell - 1} rx={r} fill="none" stroke={stroke} />
                <rect x={x} y={y + cell / 2} width={cell} height={cell / 2} fill={FILL.shaky} />
              </>
            ) : (
              <rect x={x + 0.5} y={y + 0.5} width={cell - 1} height={cell - 1} rx={r} fill={FILL[kp.state]} stroke={stroke} strokeDasharray={excluded ? '2 1.5' : undefined} />
            )}
            {kp.state === 'learned' && <circle cx={x + cell / 2} cy={y + cell / 2} r={cell * 0.15} fill="var(--mastery-new)" />}
            {kp.id === current && <rect x={x - 1.5} y={y - 1.5} width={cell + 3} height={cell + 3} rx={r + 1} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
          </g>
        );
      })}
    </svg>
  );
}

export function MapLegend() {
  const item = (state: KpState, level: Level, label: string) => (
    <span><span className={cellClass(state, level)} aria-hidden />{label}</span>
  );
  return (
    <div className={css.legend} aria-label="地图图例">
      {item('new', 'none', s.map.legendNew)}
      {item('learned', 'none', s.map.legendLearned)}
      {item('shaky', 'none', s.map.legendShaky)}
      {item('mastered', 'none', s.map.legendMastered)}
      {item('new', 'emphasized', s.map.legendEmphasis)}
      {item('new', 'excluded', s.map.legendExcluded)}
    </div>
  );
}

/** 单个格子（结果页的变化列表、卡片里用） */
export function Cell({ state, level = 'none', size = 14 }: { state: KpState; level?: Level; size?: number }) {
  return <span className={cellClass(state, level)} style={{ ['--cell' as string]: `${size}px`, display: 'inline-block' }} aria-hidden />;
}
