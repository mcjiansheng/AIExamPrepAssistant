// 课件原页：有渲染图时显示原图；演示数据只有文字层，按幻灯片的样子排版，引文高亮（06 第 7、8 节）。
import { Link } from 'react-router';
import type { Page } from '../../api/types';
import { cx } from '../../lib/cx';
import { s } from '../../strings/zh-CN';
import { Skeleton } from '../../ui/Feedback';
import { Text } from '../../ui/Text';
import css from './page.module.css';

function highlight(line: string, quote: string | null) {
  if (!quote) return line;
  const q = quote.slice(0, 18);
  const i = line.indexOf(q);
  if (i < 0) return line;
  return <>{line.slice(0, i)}<mark className={css.mark}>{line.slice(i, i + Math.max(q.length, quote.length))}</mark>{line.slice(i + Math.max(q.length, quote.length))}</>;
}

export function PagePreview({ page, quote, compact, to, loading }: { page?: Page; quote?: string | null; compact?: boolean; to?: string; loading?: boolean }) {
  if (loading || !page) return <div className={cx(css.slide, compact && css.compact)}><Skeleton height={20} width="60%" /><Skeleton height={14} /><Skeleton height={14} width="80%" /></div>;
  const [title, ...lines] = page.text.split('\n');
  const body = (
    <>
      {page.image_url ? <img src={page.image_url} alt={`${page.material_title} 第 ${page.page} 页`} className={css.image} /> : (
        <>
          <div className={css.slideTitle}>{title}</div>
          <ul className={css.lines}>{lines.slice(0, compact ? 4 : 12).map((l, i) => <li key={i}>{highlight(l, quote ?? null)}</li>)}</ul>
        </>
      )}
      <div className={css.foot}><Text variant="caption" tone="tertiary" nowrap>{page.material_title.replace(/\.\w+$/, '')}</Text><Text variant="caption" tone="tertiary" as="span">{page.page}</Text></div>
    </>
  );
  if (to) return <Link to={to} className={cx(css.slide, css.press, compact && css.compact)} aria-label={`${s.kp.pages}：${page.material_title} 第 ${page.page} 页`}>{body}</Link>;
  return <div className={cx(css.slide, compact && css.compact)}>{body}</div>;
}
