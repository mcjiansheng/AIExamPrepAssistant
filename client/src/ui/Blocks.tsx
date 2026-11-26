// 内容块：文字、列表、表格、代码、公式、图片（api-v1 Block）。公式本版按等宽文本显示，装了公式插件后渲染。
import { Link } from 'react-router';
import type { Block, Ref } from '../api/types';
import { cx } from '../lib/cx';
import css from './content.module.css';
import { Icon } from './Icon';
import { RichText } from './Text';

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className={css.blocks}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'text':
            return <p key={i} className={css.p}><RichText text={b.text} /></p>;
          case 'list': {
            const List = b.ordered ? 'ol' : 'ul';
            return <List key={i} className={cx(css.list, !b.ordered && css.bullet)}>{b.items.map((item, j) => <li key={j}><RichText text={item} /></li>)}</List>;
          }
          case 'table':
            return (
              <div key={i} className={css.tableWrap}>
                <table className={css.table}>
                  <thead><tr>{b.header.map((h, j) => <th key={j} scope="col">{h}</th>)}</tr></thead>
                  <tbody>{b.rows.map((row, j) => <tr key={j}>{row.map((cell, k) => <td key={k}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          case 'code':
            return <pre key={i} className={css.code}><code>{b.text}</code></pre>;
          case 'formula':
            return <span key={i} className={css.formula} role="math" aria-label={b.text}>{b.text}</span>;
          case 'image':
            return <img key={i} className={css.img} src={b.url} alt={b.alt} />;
        }
      })}
    </div>
  );
}

/** 出处：资料名 · 页码，点开看原页（H15） */
export function RefChip({ source: r, courseId }: { source: Ref; courseId?: string }) {
  const to = `/m/${r.material_id}/p/${r.page}${courseId ? `?c=${courseId}` : ''}${r.quote ? `${courseId ? '&' : '?'}q=${encodeURIComponent(r.quote)}` : ''}`;
  return (
    <Link to={to} className={css.ref} aria-label={`出处：${r.material_title} 第 ${r.page} 页`}>
      <Icon name="file" size={16} />
      <span className={css.refText}>{r.material_title.replace(/\.\w+$/, '')} · 第 {r.page} 页</span>
    </Link>
  );
}

export function Notice({ tone = 'info', icon = 'info', children }: { tone?: 'info' | 'warn' | 'danger'; icon?: 'info' | 'warning' | 'flag' | 'check' | 'retry'; children: React.ReactNode }) {
  return (
    <div className={cx(css.notice, tone === 'warn' && css.noticeWarn, tone === 'danger' && css.noticeDanger, tone === 'info' && css.noticeInfo)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} size={18} />
      <span>{children}</span>
    </div>
  );
}
