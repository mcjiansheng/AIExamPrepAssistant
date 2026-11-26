// 原页浏览器：页码缩略条 + 大图 + 本页的知识点；左右键翻页（06 第 8 节）。
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { usePage, usePages } from '../../api/hooks';
import { s } from '../../strings/zh-CN';
import { IconButton } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Skeleton } from '../../ui/Feedback';
import { Text } from '../../ui/Text';
import { Column, Row, Scroll } from '../../layout';
import css from './page.module.css';
import { PagePreview } from './PagePreview';

export function PageBrowser({ materialId, page, onPage, quote, courseId }: { materialId: string; page: number; onPage: (n: number) => void; quote?: string | null; courseId?: string | null }) {
  const pages = usePages(materialId);
  const current = usePage(materialId, page);
  const strip = useRef<HTMLDivElement>(null);
  const total = pages.data?.pages.length ?? current.data?.total ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowRight' && page < total) onPage(page + 1);
      if (e.key === 'ArrowLeft' && page > 1) onPage(page - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, total, onPage]);
  useEffect(() => {
    strip.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [page, pages.data]);
  const course = courseId ?? current.data?.kps[0]?.course_id;
  return (
    <Column gap={12}>
      <div ref={strip}>
        <Scroll axis="x" label="页码">
          <div className={css.thumbs}>
            {(pages.data?.pages ?? []).map((p) => (
              <button key={p.page} type="button" className={css.thumb} aria-current={p.page === page ? 'page' : undefined} onClick={() => onPage(p.page)} title={p.title ?? undefined}>{p.page}</button>
            ))}
          </div>
        </Scroll>
      </div>
      {current.isLoading ? <Skeleton height={320} radius={16} /> : <PagePreview page={current.data} quote={quote} />}
      <Row justify="between" gap={8}>
        <IconButton icon="chevronLeft" label="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <Text variant="caption" tone="secondary">第 {page} / {total || '…'} 页</Text>
        <IconButton icon="chevronRight" label="下一页" disabled={!total || page >= total} onClick={() => onPage(page + 1)} />
      </Row>
      {current.data && current.data.kps.length > 0 && (
        <Column gap={8}>
          <Text variant="caption" tone="tertiary">本页的知识点</Text>
          <Row gap={8} wrap>
            {current.data.kps.map((k) => (
              <Link key={k.id} to={`/c/${course ?? k.course_id}/kp/${k.id}`}><Chip>{k.title} · {s.kpState[k.state]}</Chip></Link>
            ))}
          </Row>
        </Column>
      )}
    </Column>
  );
}
