// 课程主页：一眼看出还剩多少、下一步做什么（06 第 6 节）。地图是主体；下一步、薄弱处、入口在侧边或下方。
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useCourseHome } from '../api/hooks';
import { usePageContext, useHighlight } from '../features/assistant/context';
import { CourseSettingsSheet, examLine, OrganizingNotice, readinessText } from '../features/course/CourseParts';
import css from '../features/course/course.module.css';
import { useStartSession } from '../features/practice/useStartSession';
import { MockSheet } from '../features/today/TodayParts';
import { useStartTask } from '../features/today/useStartTask';
import { isCompact, isWide, useBreakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import { Button, IconButton } from '../ui/Button';
import { EmptyState, ErrorState, Ring, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/icons';
import { KnowledgeMap, MapLegend, MapSkeleton } from '../ui/KnowledgeMap';
import { Page, Section, Split } from '../ui/Page';
import { Group, ListItem } from '../ui/Surfaces';
import { TaskCard } from '../ui/TaskCard';
import { Text } from '../ui/Text';
import { Column, Row } from '../layout';

export function CourseHomePage() {
  const { cid = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const bp = useBreakpoint();
  const home = useCourseHome(cid);
  const startSession = useStartSession();
  const { start, mockTask, confirmMock, cancelMock } = useStartTask();
  const [settings, setSettings] = useState(params.get('settings') === '1');
  const highlight = useHighlight('map', 'course');
  const course = home.data?.course;
  usePageContext(course ? { route: `/c/${cid}`, course_id: cid, chips: [{ key: 'course_id', label: course.name }] } : null);

  if (home.isError) return <Page back="/courses" title={s.course.home}><ErrorState error={home.error} onRetry={() => void home.refetch()} /></Page>;
  if (!home.data || !course) {
    return <Page back="/courses" title=" "><Skeleton height={96} radius={20} /><div className={css.mapBox}><MapSkeleton count={40} /></div></Page>;
  }
  const { map, next, weak } = home.data;
  const ratio = course.readiness.total ? course.readiness.mastered / course.readiness.total : 0;
  const empty = map.chapters.length === 0;
  const closeSettings = () => { setSettings(false); if (params.has('settings')) setParams({}, { replace: true }); };

  const summary = (
    <div className={css.summary}>
      <Ring value={ratio} size={80} stroke={7} color="var(--mastery-mastered)" label={`${s.course.readiness} ${Math.round(ratio * 100)}%`}>
        <span className={css.summaryNum}>{Math.round(ratio * 100)}%</span>
      </Ring>
      <Column gap={4} grow>
        <Text variant="caption" tone="secondary">{s.course.readiness}</Text>
        <Text variant="h3">{readinessText(course)}</Text>
        <Text variant="caption" tone="tertiary">已掌握 {course.readiness.mastered} / {course.readiness.total} 个重点 · 共 {course.counts.kps} 个知识点</Text>
      </Column>
    </div>
  );

  const mapBlock = (
    <div className={css.mapBox}>
      <OrganizingNotice course={course} />
      {empty && course.organizing.state === 'idle' ? (
        <EmptyState icon="file" title={s.course.addMaterialFirst} action={<Button variant="primary" icon="upload" to={`/c/${cid}/materials`}>{s.action.addMaterial}</Button>} />
      ) : (
        <KnowledgeMap chapters={map.chapters} courseId={cid} organizing={course.organizing.state === 'working'} columns={isWide(bp) ? 2 : 1} />
      )}
      {!empty && <MapLegend />}
    </div>
  );

  const nextBlock = (
    <Section title={s.course.next}>
      {next.length ? (
        <Column gap={8}>
          {next.map((t) => <TaskCard key={t.id} task={t} courseName={course.name} color={course.color} onStart={() => void start(t)} highlight={!!highlight} />)}
        </Column>
      ) : !empty ? (
        <Group padded>
          <Row justify="between" gap={12}>
            <Text variant="bodySm" tone="secondary">今天这门课没有安排</Text>
            <Button variant="primary" size="sm" icon="quick" onClick={() => void startSession({ kind: 'quick', course_id: cid, count: 5 })}>{s.action.startQuick}</Button>
          </Row>
        </Group>
      ) : null}
    </Section>
  );

  const weakBlock = weak.length > 0 && (
    <Group title={s.course.weak}>
      {weak.map((k) => <ListItem key={k.id} title={k.title} subtitle={k.chapter_title} icon="mistakes" iconTone="warning" to={`/c/${cid}/kp/${k.id}`} />)}
    </Group>
  );

  const entry = (to: string, icon: IconName, label: string, value: string) => (
    <Link to={to} className={css.entry}>
      <Icon name={icon} tone="accent" />
      <Text variant="bodySm" strong>{label}</Text>
      <Text variant="caption" tone="tertiary">{value}</Text>
    </Link>
  );
  const entries = (
    <div className={css.entries}>
      {entry(`/c/${cid}/materials`, 'file', s.course.materials, `${course.counts.materials} 份`)}
      {entry(`/c/${cid}/focus`, 'flag', s.course.focus, course.counts.fragments ? `${course.counts.fragments} 句` : '还没有')}
      {entry(`/c/${cid}/practice`, 'practice', s.course.practice, course.counts.mistakes ? `错题 ${course.counts.mistakes} 道` : '快练、模拟卷')}
      {entry(`/c/${cid}/insight`, 'trend', s.course.insight, '趋势与薄弱')}
    </div>
  );

  return (
    <Page
      back="/courses"
      title={course.name}
      titleTransition={`course-${course.id}`}
      subtitle={`${examLine(course)}${course.days_left !== null && course.days_left >= 0 ? ` · 还有 ${course.days_left} 天` : ''}`}
      actions={<IconButton icon="settings" label={s.course.settings} onClick={() => setSettings(true)} />}
    >
      {isCompact(bp) ? (
        <Column gap={24}>{summary}{mapBlock}{nextBlock}{weakBlock}{entries}</Column>
      ) : (
        <Split main={<Column gap={24}>{summary}{mapBlock}</Column>} side={<Column gap={24}>{nextBlock}{weakBlock}{entries}</Column>} ratio="2fr 1fr" />
      )}
      <CourseSettingsSheet key={`${course.id}-${settings}`} course={course} open={settings} onClose={closeSettings} />
      <MockSheet task={mockTask} onConfirm={() => void confirmMock()} onCancel={cancelMock} />
    </Page>
  );
}
