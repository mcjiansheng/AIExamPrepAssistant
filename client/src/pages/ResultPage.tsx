// 结果：得分滚动、掌握度揭晓（M4）、助手复盘与下一步、错题（06 第 13 节）。
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useResult } from '../api/hooks';
import type { Question, ReviewAction } from '../api/types';
import { usePageContext } from '../features/assistant/context';
import { useStartSession } from '../features/practice/useStartSession';
import { duration, percent } from '../lib/format';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { Tag } from '../ui/Chip';
import { BigNumber, ErrorState, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { Cell, KnowledgeMap } from '../ui/KnowledgeMap';
import { Page, Section } from '../ui/Page';
import { QuestionMeta, SolutionView } from '../ui/Question';
import { Blocks } from '../ui/Blocks';
import { Card, Group } from '../ui/Surfaces';
import { Text } from '../ui/Text';
import { Column, Row } from '../layout';

function MistakeItem({ q, courseId }: { q: Question; courseId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <QuestionMeta q={q} />
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ textAlign: 'left' }} aria-expanded={open}>
        <Blocks blocks={open ? q.stem : q.stem.slice(0, 1)} />
      </button>
      {open && <SolutionView q={q} courseId={courseId} />}
    </Card>
  );
}

export function ResultPage() {
  const { sid = '' } = useParams();
  const navigate = useNavigate();
  const result = useResult(sid);
  const start = useStartSession();
  const r = result.data;
  usePageContext(r ? { route: `/session/${sid}/result`, course_id: r.session.course_id ?? undefined, session_id: sid, chips: [{ key: 'session_id', label: `${r.session.title} 的结果` }] } : null);
  if (result.isError) return <Page back="/" title={s.result.title}><ErrorState error={result.error} onRetry={() => void result.refetch()} /></Page>;
  if (!r) return <Page back="/" title=" "><Skeleton height={120} radius={20} /><Skeleton height={200} radius={20} /></Page>;
  // 跨课程的快练没有 course_id，用题目所属的课程（变化的格子都在同一张地图上点亮）
  const courseId = r.session.course_id ?? r.session.questions.find((q) => r.mastery.some((m) => m.kp_id === q.kp.id))?.course_id ?? r.session.questions[0]?.course_id;
  const changed = r.mastery.map((m) => m.kp_id);
  const act = (a: ReviewAction) => {
    if (a.kind === 'kp' && a.kp_id) navigate(`/c/${a.session?.course_id ?? courseId}/kp/${a.kp_id}`);
    else if (a.session) void start({ kind: a.session.kind, course_id: a.session.course_id, kp_id: a.session.kp_id ?? undefined, count: a.session.count });
  };
  const actions = r.review?.actions ?? [];
  return (
    <Page back="/" title={s.sessionDone[r.session.kind]} subtitle={r.session.title} width="reading">
      <Card>
        <Column gap={12} align="center" padding={16}>
          <Row gap={4} align="baseline">
            <BigNumber value={r.score} />
            <Text variant="h3" tone="secondary" as="span">/ {r.total} 分</Text>
          </Row>
          <Row gap={16}>
            <Text variant="bodySm" tone="secondary" as="span">{s.result.accuracy} {percent(r.accuracy)}</Text>
            <Text variant="bodySm" tone="secondary" as="span">{s.result.duration} {duration(Math.max(1, Math.round(r.duration_sec / 60)))}</Text>
          </Row>
          {r.task && <Tag tone="success" icon="check">已完成今天的任务：{r.task.title}</Tag>}
        </Column>
      </Card>

      {r.review && (
        <Card tone="tinted">
          <Row gap={12} align="start">
            <Icon name="assistant" tone="accent" />
            <Column gap={12} grow>
              <Text variant="bodySm">{r.review.text}</Text>
              {actions.length > 0 && (
                <Row gap={8} wrap>
                  {actions.map((a, i) => <Button key={a.label} variant={i === 0 ? 'primary' : 'secondary'} size="sm" onClick={() => act(a)}>{a.label}</Button>)}
                </Row>
              )}
            </Column>
          </Row>
        </Card>
      )}

      {r.mastery.length > 0 && courseId && (
        <Section title={s.result.changes}>
          <Group padded>
            <Column gap={16}>
              <KnowledgeMap chapters={r.chapters} courseId={courseId} changed={changed} />
              <Column gap={8}>
                {r.mastery.map((m) => (
                  <Row key={m.kp_id} gap={8}>
                    <Cell state={m.from} /><Icon name="forward" size={16} tone="tertiary" /><Cell state={m.to} />
                    <Text variant="bodySm" as="span">{m.title}</Text>
                    <Text variant="caption" tone="tertiary" as="span">{s.kpState[m.from]} → {s.kpState[m.to]}</Text>
                  </Row>
                ))}
              </Column>
            </Column>
          </Group>
        </Section>
      )}

      {r.mistakes.length > 0 && (
        <Section title={`${s.result.mistakes} ${r.mistakes.length}`}>
          <Column gap={12}>{r.mistakes.map((q) => <MistakeItem key={q.id} q={q} courseId={courseId} />)}</Column>
        </Section>
      )}

      <Row gap={12} justify="center" wrap>
        <Button variant={actions.length ? 'neutral' : 'primary'} icon="today" to="/">{s.result.backToday}</Button>
        {r.mistakes.length > 0 && <Button variant="neutral" icon="mistakes" to="/practice/mistakes">{s.result.reviewMistakes}</Button>}
      </Row>
    </Page>
  );
}
