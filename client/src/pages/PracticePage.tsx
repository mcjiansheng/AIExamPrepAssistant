// 练习中心：快练、到期复习、错题本、模拟卷，加练习记录（06 第 11 节）。/practice 为全部课程，/c/:cid/practice 为本课。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api/endpoints';
import { invalidate, useCourses, usePractice } from '../api/hooks';
import type { SessionSummary } from '../api/types';
import { usePageContext } from '../features/assistant/context';
import css from '../features/practice/practice.module.css';
import { useStartSession } from '../features/practice/useStartSession';
import { cx } from '../lib/cx';
import { ago, duration } from '../lib/format';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Chip, Tag } from '../ui/Chip';
import { EmptyState, ErrorState, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/icons';
import { ConfirmDialog, Menu, Sheet } from '../ui/Sheet';
import { Page, Section } from '../ui/Page';
import { Group, ListItem } from '../ui/Surfaces';
import { Text } from '../ui/Text';
import { Column, Row, Scroll } from '../layout';

export function PracticePage() {
  const { cid } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const courses = useCourses();
  const [filter, setFilter] = useState<string | null>(cid ?? null);
  const hub = usePractice(filter);
  const start = useStartSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [pickMock, setPickMock] = useState(false);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const course = courses.data?.find((c) => c.id === filter);
  usePageContext({ route: cid ? `/c/${cid}/practice` : '/practice', course_id: filter ?? undefined, chips: course ? [{ key: 'course_id', label: `${course.name} · 练习` }] : [] });

  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); try { await fn(); } finally { setBusy(null); } };
  const entry = (key: string, icon: IconName, title: string, note: string, onClick: () => void, opts: { lead?: boolean; count?: number; disabled?: boolean } = {}) => (
    <button type="button" className={cx(css.entry, opts.lead && css.lead)} onClick={onClick} disabled={opts.disabled || busy !== null} aria-busy={busy === key}>
      <Row justify="between" align="start">
        <span className={css.icon}><Icon name={busy === key ? 'hourglass' : icon} /></span>
        {opts.count !== undefined && <span className={css.count}>{opts.count}</span>}
      </Row>
      <Column gap={2}>
        <Text variant="h3" tone={opts.lead ? 'onAccent' : 'primary'}>{title}</Text>
        <Text variant="caption" tone={opts.lead ? 'onAccent' : 'secondary'}>{note}</Text>
      </Column>
    </button>
  );

  const h = hub.data;
  const startMock = (courseId: string) => run('mock', () => start({ kind: 'mock', course_id: courseId }));
  return (
    <Page title={cid ? s.course.practice : s.practice.title} back={cid ? `/c/${cid}` : undefined} large={!cid} subtitle={cid ? course?.name : undefined}>
      {!cid && (courses.data?.length ?? 0) > 1 && (
        <Scroll axis="x" label="课程筛选">
          <div className={css.filters}>
            <Chip selected={!filter} onClick={() => setFilter(null)}>{s.practice.all}</Chip>
            {courses.data!.map((c) => <Chip key={c.id} selected={filter === c.id} onClick={() => setFilter(c.id)}>{c.name}</Chip>)}
          </div>
        </Scroll>
      )}
      {hub.isError ? <ErrorState error={hub.error} onRetry={() => void hub.refetch()} /> : !h ? (
        <div className={css.entries}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={132} radius={20} />)}</div>
      ) : (
        <div className={css.entries}>
          {entry('quick', 'quick', s.action.startQuick, s.practice.quickNote(h.quick.count), () => void run('quick', () => start({ kind: 'quick', course_id: filter, count: h.quick.count })), { lead: true })}
          {entry('review', 'review', s.practice.review, s.practice.reviewNote(h.review.count), () => void run('review', () => start({ kind: 'review', course_id: filter })), { count: h.review.count, disabled: !h.review.count })}
          {entry('mistakes', 'mistakes', s.practice.mistakes, s.practice.mistakesNote(h.mistakes.count), () => navigate(filter ? `/practice/mistakes?c=${filter}` : '/practice/mistakes'), { count: h.mistakes.count })}
          {entry('mock', 'mock', s.practice.mock, h.mock.available ? `${h.mock.count} 道 · ${duration(h.mock.minutes)}` : s.practice.mockNote, () => (filter ? void startMock(filter) : setPickMock(true)), { disabled: !h.mock.available })}
        </div>
      )}
      {h && (
        <Section title={s.practice.history}>
          {h.history.length === 0 ? <EmptyState icon="history" title="还没有练习记录" /> : (
            <Group>
              {h.history.map((x) => (
                <ListItem
                  key={x.id}
                  title={x.title}
                  subtitle={`${ago(x.created_at)}${x.status === 'finished' ? '' : ` · 做到 ${x.answered}/${x.question_count}`}`}
                  icon={x.kind === 'mock' ? 'mock' : x.kind === 'review' ? 'review' : x.kind === 'mistakes' ? 'mistakes' : 'quick'}
                  iconTone="neutral"
                  value={x.status === 'finished' && x.score !== null ? <Text variant="bodySm" strong as="span">{x.score}/{x.total}</Text> : <Tag tone="accent">{s.action.continue}</Tag>}
                  onClick={() => navigate(x.status === 'finished' ? `/session/${x.id}/result` : `/session/${x.id}`)}
                  trailing={<span onClick={(e) => e.stopPropagation()}><Menu items={[{ label: s.action.delete, icon: 'trash', danger: true, onSelect: () => setDeleting(x) }]} /></span>}
                />
              ))}
            </Group>
          )}
        </Section>
      )}
      <Sheet open={pickMock} onClose={() => setPickMock(false)} title="哪门课的模拟卷">
        <div>
          {(courses.data ?? []).map((c) => <ListItem key={c.id} title={c.name} subtitle={c.days_left !== null ? `还有 ${c.days_left} 天考试` : undefined} onClick={() => { setPickMock(false); void startMock(c.id); }} chevron />)}
        </div>
      </Sheet>
      <ConfirmDialog
        open={!!deleting} title={`删除“${deleting?.title ?? ''}”？`} body="作答记录会一起删掉，掌握度按剩下的记录重新计算。" confirm={s.action.delete} danger onCancel={() => setDeleting(null)}
        onConfirm={async () => { const x = deleting!; setDeleting(null); await api.deleteSession(x.id); invalidate(qc, ['practice', 'map', 'course', 'today']); useUi.getState().toast('已删除'); }}
      />
    </Page>
  );
}
