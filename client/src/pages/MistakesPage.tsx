// 错题本：再做一遍、来一道同类的、移出（可撤销）；在两次不同的练习里做对自动移出（09 第 7.5 节）。
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { useApply, useCourses, useMistakes } from '../api/hooks';
import type { Mistake } from '../api/types';
import { usePageContext } from '../features/assistant/context';
import css from '../features/practice/practice.module.css';
import { useStartSession } from '../features/practice/useStartSession';
import { ago } from '../lib/format';
import { s } from '../strings/zh-CN';
import { Blocks } from '../ui/Blocks';
import { Button } from '../ui/Button';
import { Chip, Tag } from '../ui/Chip';
import { EmptyState, ErrorState, Skeleton } from '../ui/Feedback';
import { Page } from '../ui/Page';
import { SolutionView } from '../ui/Question';
import { Text } from '../ui/Text';
import { Column, Row, Scroll } from '../layout';

function MistakeCard({ m }: { m: Mistake }) {
  const [open, setOpen] = useState(false);
  const apply = useApply();
  const start = useStartSession();
  const navigate = useNavigate();
  const stem = m.question.stem.filter((b) => b.kind === 'text').slice(0, 1);
  return (
    <div className={css.mistake}>
      <Row gap={8} wrap>
        <Tag>{s.qtype[m.question.type]}</Tag>
        <Text variant="caption" tone="secondary" as="span">{m.course_name} · {m.question.kp.title}</Text>
      </Row>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ textAlign: 'left' }} aria-expanded={open}>
        {open ? <Blocks blocks={m.question.stem} /> : <Blocks blocks={stem.length ? stem : m.question.stem.slice(0, 1)} />}
      </button>
      <Row gap={12} wrap>
        <Text variant="caption" tone="danger" as="span">{m.reason}</Text>
        <Text variant="caption" tone="tertiary" as="span">{ago(m.last_wrong_at)}</Text>
        <span className={css.streak} aria-label={s.practice.streak(m.correct_streak)}>
          {[0, 1].map((i) => <span key={i} className={i < m.correct_streak ? css.on : undefined} />)}
        </span>
      </Row>
      {open && <SolutionView q={m.question} />}
      <Row gap={8} wrap>
        <Button size="sm" variant="secondary" icon="retry" onClick={() => void start({ kind: 'mistakes', course_id: m.course_id, question_ids: [m.question.bank_id] })}>{s.practice.redo}</Button>
        <Button size="sm" variant="neutral" onClick={async () => { const session = await api.similar(m.question.bank_id).catch(() => null); if (session) navigate(`/session/${session.id}`); }}>{s.practice.similar}</Button>
        <Button size="sm" variant="text" onClick={() => void apply(() => api.removeMistake(m.question.bank_id))}>{s.practice.remove}</Button>
      </Row>
    </div>
  );
}

export function MistakesPage() {
  const [params] = useSearchParams();
  const courses = useCourses();
  const [filter, setFilter] = useState<string | null>(params.get('c'));
  const mistakes = useMistakes(filter);
  const start = useStartSession();
  usePageContext({ route: '/practice/mistakes', course_id: filter ?? undefined, chips: [{ key: 'route', label: s.practice.mistakes }] });
  const list = mistakes.data ?? [];
  return (
    <Page back="/practice" title={s.practice.mistakes} width="reading"
      actions={list.length > 0 ? <Button size="sm" variant="primary" icon="retry" onClick={() => void start({ kind: 'mistakes', course_id: filter })}>全部重做</Button> : undefined}>
      {(courses.data?.length ?? 0) > 1 && (
        <Scroll axis="x" label="课程筛选">
          <div className={css.filters}>
            <Chip selected={!filter} onClick={() => setFilter(null)}>{s.practice.all}</Chip>
            {courses.data!.map((c) => <Chip key={c.id} selected={filter === c.id} onClick={() => setFilter(c.id)}>{c.name}</Chip>)}
          </div>
        </Scroll>
      )}
      {mistakes.isError ? <ErrorState error={mistakes.error} onRetry={() => void mistakes.refetch()} />
        : mistakes.isLoading ? <Column gap={12}>{[0, 1, 2].map((i) => <Skeleton key={i} height={140} radius={16} />)}</Column>
        : list.length === 0 ? <EmptyState icon="checkCircle" title="错题本是空的" />
        : <Column gap={12}>{list.map((m) => <MistakeCard key={m.question.bank_id} m={m} />)}</Column>}
    </Page>
  );
}
