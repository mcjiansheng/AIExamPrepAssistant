// 学情：来得及吗（06 第 14 节）。手机上只显示结论 + 地图 + 薄弱列表；大屏加趋势、各章分布和用时。
import { useState } from 'react';
import { useParams } from 'react-router';
import { useCourseHome, useInsight } from '../api/hooks';
import type { KpState } from '../api/types';
import { usePageContext } from '../features/assistant/context';
import { duration, percent, shortDate } from '../lib/format';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { DataTable, HBars, Legend, LineChart, SegmentBar } from '../ui/Charts';
import { ErrorState, Skeleton } from '../ui/Feedback';
import { KnowledgeMap } from '../ui/KnowledgeMap';
import { Page, Section, Split } from '../ui/Page';
import { Group, ListItem } from '../ui/Surfaces';
import { Text } from '../ui/Text';
import { Column, Row } from '../layout';

const STATES: { key: KpState; color: string }[] = [
  { key: 'mastered', color: 'var(--mastery-mastered)' },
  { key: 'shaky', color: 'var(--mastery-shaky)' },
  { key: 'learned', color: 'var(--mastery-new)' },
  { key: 'new', color: 'var(--bg-sunken)' },
];

export function InsightPage() {
  const { cid = '' } = useParams();
  const bp = useBreakpoint();
  const insight = useInsight(cid);
  const home = useCourseHome(cid);
  const [table, setTable] = useState(false);
  const d = insight.data;
  usePageContext(home.data ? { route: `/c/${cid}/insight`, course_id: cid, chips: [{ key: 'course_id', label: `${home.data.course.name} · 学情` }] } : null);
  if (insight.isError) return <Page back={`/c/${cid}`} title={s.insight.title}><ErrorState error={insight.error} onRetry={() => void insight.refetch()} /></Page>;
  if (!d) return <Page back={`/c/${cid}`} title={s.insight.title}><Skeleton height={64} /><Skeleton height={200} radius={20} /></Page>;

  const verdict = <Text variant="h2">{d.verdict}</Text>;
  const weak = (
    <Group title={s.insight.weak}>
      {d.weak.length ? d.weak.map((k) => <ListItem key={k.id} title={k.title} subtitle={k.chapter_title} icon="mistakes" iconTone="warning" to={`/c/${cid}/kp/${k.id}`} />)
        : <ListItem title="没有不稳的知识点" icon="checkCircle" iconTone="success" />}
    </Group>
  );
  if (isCompact(bp)) {
    return (
      <Page back={`/c/${cid}`} title={s.insight.title} subtitle={home.data?.course.name}>
        {verdict}
        {home.data && <Group padded><KnowledgeMap chapters={home.data.map.chapters} courseId={cid} /></Group>}
        {weak}
      </Page>
    );
  }
  const trend = (
    <Section title={s.insight.trend}>
      <Group padded>
        <LineChart label={s.insight.trend} points={d.readiness.map((p) => ({ x: p.date, y: p.ratio, label: shortDate(p.date) }))} format={percent} />
      </Group>
    </Section>
  );
  const chapters = (
    <Section title={s.insight.chapters} action={<Button variant="text" size="sm" icon={table ? 'grid' : 'list'} onClick={() => setTable((v) => !v)}>{table ? '图表' : '表格'}</Button>}>
      <Group padded>
        {table ? (
          <DataTable caption={s.insight.chapters} columns={['章节', ...STATES.map((x) => s.kpState[x.key])]} rows={d.chapters.map((c) => [c.title, c.mastered, c.shaky, c.learned, c.new])} />
        ) : (
          <Column gap={16}>
            <Legend items={STATES.map((x) => ({ name: s.kpState[x.key], color: x.color }))} />
            {d.chapters.map((c) => (
              <Column key={c.id} gap={8}>
                <Row justify="between"><Text variant="bodySm" nowrap>{c.title}</Text><Text variant="caption" tone="tertiary" as="span">掌握 {c.mastered}/{c.mastered + c.shaky + c.learned + c.new}</Text></Row>
                <SegmentBar label={c.title} parts={STATES.map((x) => ({ key: x.key, name: s.kpState[x.key], color: x.color, value: c[x.key] }))} />
              </Column>
            ))}
          </Column>
        )}
      </Group>
    </Section>
  );
  const time = (
    <Section title={s.insight.time}>
      <Group padded>
        <Column gap={12}>
          <Text variant="h3">{duration(d.minutes.total)}</Text>
          <HBars format={(v) => `${v} 分钟`} rows={[
            { key: 'learn', name: s.taskKind.learn, value: d.minutes.learn },
            { key: 'practice', name: s.taskKind.practice, value: d.minutes.practice },
            { key: 'review', name: s.taskKind.review, value: d.minutes.review },
            { key: 'mock', name: s.taskKind.mock, value: d.minutes.mock },
          ]} />
        </Column>
      </Group>
    </Section>
  );
  return (
    <Page back={`/c/${cid}`} title={s.insight.title} subtitle={home.data?.course.name}>
      {verdict}
      <Split main={<Column gap={24}>{trend}{chapters}</Column>} side={<Column gap={24}>{weak}{time}</Column>} ratio="3fr 2fr" />
    </Page>
  );
}
