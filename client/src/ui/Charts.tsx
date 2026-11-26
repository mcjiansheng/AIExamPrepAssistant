// 图表（学情、用量）：单序列不放图例，标题说明画的是什么；悬停或键盘聚焦显示数值；都带表格视图。
import { useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import css from './charts.module.css';
import { Text } from './Text';

const W = 640;

/** 折线（随时间变化）：2px 线 + 10% 面积 + 末端点；十字线提示 */
export function LineChart({ points, format, label, height = 180, color = 'var(--accent)', max = 1 }: {
  points: { x: string; y: number; label: string }[];
  format: (y: number) => string;
  label: string;
  height?: number;
  color?: string;
  max?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pad = { l: 36, r: 12, t: 12, b: 24 };
  const h = height;
  const innerW = W - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const n = points.length;
  const xs = (i: number) => pad.l + (n <= 1 ? innerW : (i / (n - 1)) * innerW);
  const ys = (v: number) => pad.t + innerH - (Math.min(max, Math.max(0, v)) / max) * innerH;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i)},${ys(p.y)}`).join(' ');
  const area = n ? `${path} L${xs(n - 1)},${pad.t + innerH} L${xs(0)},${pad.t + innerH} Z` : '';
  const ticks = [0, max / 2, max];
  const onMove = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !n) return;
    const x = ((clientX - r.left) / r.width) * W;
    const i = Math.round(((x - pad.l) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const last = points[n - 1];
  return (
    <div className={css.chart} ref={box} onPointerMove={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)}
      tabIndex={0} role="img" aria-label={`${label}：${points.map((p) => `${p.label} ${format(p.y)}`).join('，')}`}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') setHover((v) => Math.min(n - 1, (v ?? -1) + 1)); if (e.key === 'ArrowLeft') setHover((v) => Math.max(0, (v ?? n) - 1)); }}
      onBlur={() => setHover(null)}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ height }} aria-hidden>
        {ticks.map((t) => (
          <g key={t}>
            <line className={css.grid} x1={pad.l} x2={W - pad.r} y1={ys(t)} y2={ys(t)} vectorEffect="non-scaling-stroke" />
            <text className={css.axis} x={pad.l - 8} y={ys(t) + 4} textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {n > 1 && <path d={area} fill={color} className={css.area} />}
        {n > 1 && <path d={path} stroke={color} className={css.line} vectorEffect="non-scaling-stroke" />}
        {hover !== null && <line className={css.cross} x1={xs(hover)} x2={xs(hover)} y1={pad.t} y2={pad.t + innerH} vectorEffect="non-scaling-stroke" />}
        {last && <circle cx={xs(n - 1)} cy={ys(last.y)} r={5} fill={color} className={css.dot} />}
        {hover !== null && points[hover] && <circle cx={xs(hover)} cy={ys(points[hover]!.y)} r={5} fill={color} className={css.dot} />}
        {points.length > 0 && <text className={css.axis} x={pad.l} y={h - 6}>{points[0]!.label}</text>}
        {last && n > 1 && <text className={css.axis} x={W - pad.r} y={h - 6} textAnchor="end">{last.label}</text>}
      </svg>
      {hover !== null && points[hover] && (
        <div className={css.tip} style={{ left: `${(xs(hover) / W) * 100}%`, top: `${(ys(points[hover]!.y) / h) * 100}%` }}>
          <span>{points[hover]!.label}</span> {format(points[hover]!.y)}
        </div>
      )}
    </div>
  );
}

/** 柱（按天的量）：柱宽不超过 24px，顶端 4px 圆角，底部方角 */
export function Columns({ data, format, label, height = 160, color = 'var(--accent)' }: {
  data: { key: string; label: string; value: number }[];
  format: (v: number) => string;
  label: string;
  height?: number;
  color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 8, t: 12, b: 22 };
  const innerW = W - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = niceMax(max);
  const slot = innerW / Math.max(1, data.length);
  const bw = Math.min(24, slot * 0.6);
  return (
    <div className={css.chart} role="img" aria-label={`${label}：${data.map((d) => `${d.label} ${format(d.value)}`).join('，')}`}>
      <svg className={css.svg} viewBox={`0 0 ${W} ${height}`} style={{ height }} aria-hidden>
        {[0, nice / 2, nice].map((t) => {
          const y = pad.t + innerH - (t / nice) * innerH;
          return <g key={t}><line className={css.grid} x1={pad.l} x2={W - pad.r} y1={y} y2={y} /><text className={css.axis} x={pad.l - 8} y={y + 4} textAnchor="end">{format(t)}</text></g>;
        })}
        {data.map((d, i) => {
          const hgt = (d.value / nice) * innerH;
          const x = pad.l + slot * i + (slot - bw) / 2;
          const y = pad.t + innerH - hgt;
          const r = Math.min(4, hgt / 2);
          const base = y + hgt;
          return (
            <g key={d.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={innerH} fill="transparent" />
              {hgt > 0 && <path className={cx(css.col, hover !== null && hover !== i && css.colDim)} fill={color}
                d={`M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z`} />}
              {(i === 0 || i === data.length - 1 || data.length <= 8) && <text className={css.axis} x={x + bw / 2} y={height - 6} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className={css.tip} style={{ left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%`, top: `${((pad.t + innerH - (data[hover]!.value / nice) * innerH) / height) * 100}%` }}>
          <span>{data[hover]!.label}</span> {format(data[hover]!.value)}
        </div>
      )}
    </div>
  );
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** 一个整体分成几部分（细条，8px，圆角，无文字）；部分的名称、数量、占比由图例和读屏文字给出 */
export function SegmentBar({ parts, label }: { parts: { key: string; value: number; color: string; name: string }[]; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div className={css.seg} role="img" aria-label={`${label}：${parts.map((p) => `${p.name} ${p.value}（${Math.round((p.value / total) * 100)}%）`).join('，')}`}>
      {parts.filter((p) => p.value > 0).map((p) => <span key={p.key} style={{ flexGrow: p.value, background: p.color }} title={`${p.name} ${p.value}`} />)}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return <div className={css.legend}>{items.map((i) => <span key={i.name}><span className={css.key} style={{ background: i.color }} aria-hidden />{i.name}</span>)}</div>;
}

/** 横条（数量比较）：值写在条的末端，用文字色 */
export function HBars({ rows, format }: { rows: { key: string; name: ReactNode; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div role="list">
      {rows.map((r) => (
        <div key={r.key} className={css.hrow} role="listitem">
          <Text variant="caption" tone="secondary" nowrap>{r.name}</Text>
          <div className={css.htrack}><div className={css.hbar} style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <Text variant="caption" as="span">{format(r.value)}</Text>
        </div>
      ))}
    </div>
  );
}

/** 表格视图：图表的数据都能以表格读到（可达性） */
export function DataTable({ columns, rows, caption }: { columns: string[]; rows: (string | number)[][]; caption: string }) {
  const id = useId();
  return (
    <table className={css.table} aria-describedby={id}>
      <caption id={id} className="sr-only">{caption}</caption>
      <thead><tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}
