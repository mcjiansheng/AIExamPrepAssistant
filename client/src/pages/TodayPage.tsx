// 今天：回答“现在做什么”（06 第 3 节）。结论（倒计时、进度）→ 现在要做的事（任务）→ 其他。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { keys, useApply, useCourses, useNotifications, useToday } from '../api/hooks';
import type { Task, Today } from '../api/types';
import { usePageContext, useHighlight } from '../features/assistant/context';
import { AllDone, Briefing, EmptyToday, MockSheet, ResumeCard, TasksHeader, TimeSheet, WeekOverview } from '../features/today/TodayParts';
import { useStartTask } from '../features/today/useStartTask';
import { useStartSession } from '../features/practice/useStartSession';
import { addDaysIso, longDate } from '../lib/format';
import { useFlip } from '../lib/motion';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import { Notice } from '../ui/Blocks';
import { IconButton } from '../ui/Button';
import { CountdownPill, TaskCard } from '../ui/TaskCard';
import { ErrorState, Loading, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { Page, Section, Split } from '../ui/Page';
import { Column, Scroll } from '../layout';

export function TodayPage() {
  const bp = useBreakpoint();
  const today = useToday();
  const courses = useCourses();
  const notifications = useNotifications();
  const apply = useApply();
  const navigate = useNavigate();
  const { start, mockTask, confirmMock, cancelMock } = useStartTask();
  const startSession = useStartSession();
  const [timeOpen, setTimeOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const qc = useQueryClient();
  const highlight = useHighlight('today');
  const tasks = today.data?.tasks ?? [];
  const flip = useFlip<HTMLDivElement>([tasks.map((t) => t.id).join(), highlight]);
  usePageContext({ route: '/', chips: [{ key: 'route', label: s.today.title }] });

  const courseOf = (t: Task) => courses.data?.find((c) => c.id === t.course_id);
  /** 乐观更新：先把任务移出列表、进度环增长（M2），失败时回滚 */
  const update = async (task: Task, body: { status?: Task['status']; date?: string }) => {
    const prev = qc.getQueryData<Today>(keys.today);
    if (prev) {
      const finished = body.status === 'done' || body.status === 'skipped';
      qc.setQueryData<Today>(keys.today, {
        ...prev,
        tasks: prev.tasks.filter((t) => t.id !== task.id),
        done: finished ? [...prev.done, { ...task, status: body.status! }] : prev.done,
        progress: body.status === 'done' ? { ...prev.progress, done: prev.progress.done + 1 } : prev.progress,
      });
    }
    try { await apply(() => api.updateTask(task.id, body)); } catch { if (prev) qc.setQueryData(keys.today, prev); }
  };
  const menu = (task: Task) => [
    { label: s.today.moveTomorrow, icon: 'forward' as const, onSelect: () => void update(task, { date: addDaysIso(today.data!.date, 1) }) },
    { label: s.today.skip, icon: 'close' as const, onSelect: () => void update(task, { status: 'skipped' }) },
    { label: s.today.goCourse, icon: 'courses' as const, onSelect: () => navigate(`/c/${task.course_id}`) },
  ];

  const actions = isCompact(bp) ? (
    <>
      <IconButton icon="schedule" label={s.nav.schedule} to="/schedule" />
      <IconButton icon="bell" label={s.nav.notifications} to="/notifications" badge={!!notifications.data?.unread} />
    </>
  ) : undefined;

  if (today.isError) return <Page title={s.today.title} large><ErrorState error={today.error} onRetry={() => void today.refetch()} /></Page>;
  const data = today.data;
  const noCourses = courses.data?.length === 0;

  const main = (
    <Column gap={24}>
      {data?.notice && <Notice icon="info">{data.notice}</Notice>}
      {data?.briefing && <Briefing text={data.briefing} />}
      {data && data.countdowns.length > 0 && (
        <Scroll axis="x" label="考试倒计时">
          <div style={{ display: 'flex', gap: 8 }}>{data.countdowns.map((c) => <CountdownPill key={c.course_id} countdown={c} to={`/c/${c.course_id}`} />)}</div>
        </Scroll>
      )}
      {isCompact(bp) && data?.resume && <ResumeCard resume={data.resume} courses={courses.data ?? []} />}
      {noCourses ? <EmptyToday /> : (
        <Section>
          {data ? <TasksHeader today={data} onAdjust={() => setTimeOpen(true)} /> : <Skeleton height={44} />}
          {!data ? (
            <Loading><Column gap={8}>{[0, 1, 2].map((i) => <Skeleton key={i} height={68} radius={16} />)}</Column></Loading>
          ) : tasks.length === 0 ? (
            <AllDone tomorrow={data.tomorrow} onQuick={() => void startSession({ kind: 'quick', count: 5 })} />
          ) : (
            <div ref={flip} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tasks.map((t, i) => (
                <div key={t.id} data-flip={t.id}>
                  <TaskCard
                    task={t} courseName={courseOf(t)?.name ?? ''} color={courseOf(t)?.color ?? 0}
                    onStart={() => void start(t)} onDone={() => void update(t, { status: 'done' })} menu={menu(t)}
                    transitionName={i === 0 && t.kind === 'learn' ? `kp-${t.kp_ids[0]}` : undefined}
                    highlight={!!highlight}
                  />
                </div>
              ))}
            </div>
          )}
          {data && data.done.length > 0 && (
            <>
              <button type="button" onClick={() => setShowDone((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 40, color: 'var(--text-secondary)', fontSize: 'var(--fs-body-sm)' }} aria-expanded={showDone}>
                <Icon name={showDone ? 'chevronUp' : 'chevronDown'} size={18} />{s.today.done} {data.done.length}
              </button>
              {showDone && <Column gap={8}>{data.done.map((t) => <TaskCard key={t.id} task={t} courseName={courseOf(t)?.name ?? ''} color={courseOf(t)?.color ?? 0} onStart={() => void start(t)} />)}</Column>}
            </>
          )}
        </Section>
      )}
    </Column>
  );

  const side = (
    <Column gap={24}>
      {data?.resume && <ResumeCard resume={data.resume} courses={courses.data ?? []} />}
      {!noCourses && <Section title="本周"><WeekOverview /></Section>}
    </Column>
  );

  return (
    <Page title={s.today.title} subtitle={data ? longDate(data.date) : undefined} large actions={actions}>
      {isCompact(bp) ? main : <Split main={main} side={side} ratio="3fr 2fr" stickySide />}
      <TimeSheet key={String(timeOpen)} open={timeOpen} current={data?.minutes_available ?? 120} onClose={() => setTimeOpen(false)} />
      <MockSheet task={mockTask} onConfirm={() => void confirmMock()} onCancel={cancelMock} />
    </Page>
  );
}
