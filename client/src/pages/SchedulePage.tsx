// 日程：考试周视图，任务按课程色块堆叠；拖动改日期（电脑、平板），手机上点任务 → 挪到……（06 第 10 节、M6）。
import { useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { useApply, useCourses, useSchedule, useSettings } from '../api/hooks';
import type { Intensity, ScheduleDay, Task } from '../api/types';
import { usePageContext, useHighlight } from '../features/assistant/context';
import css from '../features/schedule/schedule.module.css';
import { useStartTask } from '../features/today/useStartTask';
import { MockSheet } from '../features/today/TodayParts';
import { cx } from '../lib/cx';
import { addDaysIso, duration, relativeDay, shortDate, todayIso, weekday } from '../lib/format';
import { useFlip } from '../lib/motion';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { ErrorState, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { Segmented, Stepper } from '../ui/Inputs';
import { Sheet } from '../ui/Sheet';
import { Page, Section } from '../ui/Page';
import { ListItem } from '../ui/Surfaces';
import { TaskCard } from '../ui/TaskCard';
import { Text } from '../ui/Text';
import { Column } from '../layout';

export function SchedulePage() {
  const bp = useBreakpoint();
  const navigate = useNavigate();
  const apply = useApply();
  const from = todayIso();
  const schedule = useSchedule(from, addDaysIso(from, 13));
  const settings = useSettings();
  const courses = useCourses();
  const { start, mockTask, confirmMock, cancelMock } = useStartTask();
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menuTask, setMenuTask] = useState<Task | null>(null);
  const [week, setWeek] = useState(false);
  const highlight = useHighlight('schedule', 'today');
  const days = schedule.data?.days ?? [];
  const flip = useFlip<HTMLDivElement>([days.map((d) => d.tasks.map((t) => t.id).join()).join('|'), highlight]);
  usePageContext({ route: '/schedule', chips: [{ key: 'route', label: s.schedule.title }] });

  const courseOf = (t: Task) => courses.data?.find((c) => c.id === t.course_id);
  const move = (taskId: string, date: string) => {
    const task = days.flatMap((d) => d.tasks).find((t) => t.id === taskId);
    if (!task || task.date === date) return;
    void apply(() => api.updateTask(taskId, { date }));
  };
  const onDrop = (e: DragEvent, date: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setOver(null);
    setDragId(null);
    if (id) move(id, date);
  };

  const controls = settings.data && schedule.data && (
    <div className={css.controls}>
      <div className={css.control}>
        <Text variant="bodySm" tone="secondary">{s.schedule.daily}</Text>
        <Stepper label={s.schedule.daily} value={settings.data.daily_minutes} min={30} max={600} step={15} format={duration} onChange={(v) => void apply(() => api.updateSettings({ daily_minutes: v }), { undo: false })} />
      </div>
      <div className={css.control}>
        <Text variant="bodySm" tone="secondary">{s.schedule.intensity}</Text>
        <Segmented<Intensity> label={s.schedule.intensity} value={settings.data.intensity} onChange={(v) => void apply(() => api.updateSettings({ intensity: v }), { undo: false })}
          options={(['easy', 'standard', 'sprint'] as Intensity[]).map((v) => ({ value: v, label: s.intensity[v] }))} />
      </div>
      <Button variant="text" size="sm" icon="retry" onClick={() => void apply(() => api.rebuildSchedule())}>{s.schedule.rebuild}</Button>
    </div>
  );

  const column = (d: ScheduleDay) => {
    const ratio = d.minutes_available ? d.minutes_planned / d.minutes_available : 0;
    return (
      <div
        key={d.date} className={cx(css.col, d.date === from && css.colToday, over === d.date && css.over)}
        onDragOver={(e) => { e.preventDefault(); setOver(d.date); }} onDragLeave={() => setOver((o) => (o === d.date ? null : o))} onDrop={(e) => onDrop(e, d.date)}
        aria-label={`${relativeDay(d.date)}，安排 ${d.minutes_planned} 分钟`}
      >
        <div className={css.colHead}>
          <div className={css.dayLine}>
            <Text variant="h3" tone={d.date === from ? 'accent' : 'primary'} as="span">{relativeDay(d.date).length <= 2 ? relativeDay(d.date) : weekday(d.date)}</Text>
            <Text variant="caption" tone="tertiary" as="span">{shortDate(d.date)}</Text>
          </div>
          <div className={css.cap}><div className={cx(css.capFill, ratio > 1 && css.capOver)} style={{ width: `${Math.min(1, ratio) * 100}%` }} /></div>
          <Text variant="caption" tone="tertiary">{d.minutes_planned}/{d.minutes_available} 分钟</Text>
        </div>
        {d.exams.map((e) => <div key={e.course_id} className={css.exam} style={{ background: `var(--course-${e.color % 8})` }}><Icon name="flag" size={16} />{e.name}{s.schedule.exam}</div>)}
        {d.tasks.map((t) => {
          const c = courseOf(t);
          return (
            <button
              key={t.id} data-flip={t.id} type="button" draggable={!isCompact(bp) && t.status === 'todo'}
              className={cx(css.block, t.status !== 'todo' && css.blockDone, dragId === t.id && css.dragging)}
              style={{ background: `color-mix(in srgb, var(--course-${(c?.color ?? 0) % 8}) 10%, var(--bg-surface))`, ['--c' as string]: `var(--course-${(c?.color ?? 0) % 8})` }}
              onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; setDragId(t.id); }}
              onDragEnd={() => { setDragId(null); setOver(null); }}
              onClick={() => setMenuTask(t)}
              aria-label={`${t.title}，${c?.name ?? ''}，${t.minutes} 分钟`}
            >
              <span className={css.blockTitle}>{t.title}</span>
              <Text variant="caption" tone="secondary" as="span">{c?.name} · {t.minutes} 分</Text>
            </button>
          );
        })}
      </div>
    );
  };

  const taskSheet = (
    <Sheet open={!!menuTask} onClose={() => setMenuTask(null)} title={menuTask?.title}>
      {menuTask && (
        <Column gap={16}>
          <Text variant="bodySm" tone="secondary">{courseOf(menuTask)?.name} · {duration(menuTask.minutes)} · {menuTask.reason}</Text>
          {menuTask.status === 'todo' && <Button variant="primary" icon="play" onClick={() => { const t = menuTask; setMenuTask(null); void start(t); }}>{s.action.start}</Button>}
          <Section title={s.schedule.moveTo}>
            <div>
              {days.slice(0, 7).filter((d) => d.date !== menuTask.date).map((d) => (
                <ListItem key={d.date} title={`${relativeDay(d.date)} · ${shortDate(d.date)}`} value={`${d.minutes_planned}/${d.minutes_available} 分`} onClick={() => { const t = menuTask; setMenuTask(null); move(t.id, d.date); }} />
              ))}
              <ListItem title={s.today.skip} icon="close" iconTone="neutral" onClick={() => { const t = menuTask; setMenuTask(null); void apply(() => api.updateTask(t.id, { status: 'skipped' })); }} />
              <ListItem title={s.today.goCourse} icon="courses" onClick={() => { const t = menuTask; setMenuTask(null); navigate(`/c/${t.course_id}`); }} />
            </div>
          </Section>
        </Column>
      )}
    </Sheet>
  );

  if (schedule.isError) return <Page title={s.schedule.title} back={isCompact(bp) ? '/' : undefined} large={!isCompact(bp)}><ErrorState error={schedule.error} onRetry={() => void schedule.refetch()} /></Page>;
  return (
    <Page title={s.schedule.title} back={isCompact(bp) ? '/' : undefined} large={!isCompact(bp)} width="full">
      {controls ?? <Skeleton height={64} radius={20} />}
      {!schedule.data ? <Skeleton height={320} radius={16} /> : isCompact(bp) && !week ? (
        <Column gap={24}>
          {days.slice(0, 2).map((d) => (
            <Section key={d.date} title={`${relativeDay(d.date)} · ${d.minutes_planned}/${d.minutes_available} 分钟`}>
              {d.exams.map((e) => <div key={e.course_id} className={css.exam} style={{ background: `var(--course-${e.color % 8})` }}><Icon name="flag" size={16} />{e.name}{s.schedule.exam}</div>)}
              <div className={css.dayList}>
                {d.tasks.length === 0 ? <Text tone="tertiary">{s.schedule.free}</Text> : d.tasks.map((t) => (
                  <TaskCard key={t.id} task={t} courseName={courseOf(t)?.name ?? ''} color={courseOf(t)?.color ?? 0} onStart={() => setMenuTask(t)} />
                ))}
              </div>
            </Section>
          ))}
          <Button variant="secondary" icon="schedule" onClick={() => setWeek(true)}>{s.schedule.week}</Button>
        </Column>
      ) : (
        <div ref={flip} className={css.week}>{days.map(column)}</div>
      )}
      {taskSheet}
      <MockSheet task={mockTask} onConfirm={() => void confirmMock()} onCancel={cancelMock} />
    </Page>
  );
}
