// 今天页的组成部分：每日简报、继续上次、本周概览、调整时间、全部完成、模拟卷确认。
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/endpoints';
import { useApply, useCourses, usePractice, useSchedule } from '../../api/hooks';
import type { Course, Resume, Task, Today } from '../../api/types';
import { cx } from '../../lib/cx';
import { ago, duration, relativeDay, shortDate, todayIso, weekday } from '../../lib/format';
import { s } from '../../strings/zh-CN';
import { Button, IconButton } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Ring, Skeleton } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Stepper } from '../../ui/Inputs';
import { Sheet } from '../../ui/Sheet';
import { Card } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';
import css from './today.module.css';

const HIDE = 'fullgrid.brief.hidden';

export function Briefing({ text }: { text: string }) {
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(HIDE) === todayIso());
  if (hidden) return null;
  return (
    <div className={css.brief}>
      <Icon name="assistant" tone="accent" />
      <p className={css.briefText}>{text}</p>
      <IconButton icon="close" label="收起简报" size="sm" onClick={() => { sessionStorage.setItem(HIDE, todayIso()); setHidden(true); }} />
    </div>
  );
}

export function ResumeCard({ resume, courses }: { resume: Resume; courses: Course[] }) {
  const course = courses.find((c) => c.id === resume.course_id);
  return (
    <Card to={resume.href} tone="tinted" color={course?.color} label={`${s.today.resume}：${resume.title}`}>
      <div className={css.resume}>
        <span className={css.resumeIcon}><Icon name={resume.kind === 'kp' ? 'learn' : 'play'} /></span>
        <Column gap={2} grow>
          <Text variant="caption" tone="accent" strong>{s.today.resume}{resume.device ? ` · 来自${resume.device}` : ''}</Text>
          <Text variant="h3" nowrap>{resume.title}</Text>
          <Text variant="caption" tone="secondary" nowrap>{[course?.name, resume.detail, ago(resume.updated_at)].filter(Boolean).join(' · ')}</Text>
        </Column>
        <Icon name="chevronRight" tone="tertiary" />
      </div>
    </Card>
  );
}

export function TasksHeader({ today, onAdjust }: { today: Today; onAdjust: () => void }) {
  const { done, total } = today.progress;
  return (
    <div className={css.tasksHead}>
      <Ring value={total ? done / total : 0} size={44} stroke={5} label={`今日进度：${done}/${total}`}>
        <span className={css.ringText}>{done}/{total}</span>
      </Ring>
      <Column gap={0} grow>
        <Text variant="h3" as="h2">{s.today.tasks}</Text>
        <Text variant="caption" tone="secondary">约 {duration(today.minutes_planned)} · 今天可用 {duration(today.minutes_available)}</Text>
      </Column>
      <Button variant="text" size="sm" icon="clock" onClick={onAdjust}>{s.today.adjust}</Button>
    </div>
  );
}

export function TimeSheet({ open, current, onClose }: { open: boolean; current: number; onClose: () => void }) {
  const apply = useApply();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const save = async (minutes: number) => {
    setBusy(true);
    try { await apply(() => api.setTodayMinutes(minutes)); onClose(); } catch { /* 已提示 */ } finally { setBusy(false); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={s.today.timeTitle} footer={<Button variant="primary" block loading={busy} onClick={() => void save(value)}>{s.action.confirm}</Button>}>
      <Column gap={24}>
        <div className={css.presets}>
          {[30, 60, 90, 120, 180, 240].map((m) => <Chip key={m} selected={value === m} onClick={() => setValue(m)}>{duration(m)}</Chip>)}
        </div>
        <Row justify="between">
          <Text tone="secondary">自定义</Text>
          <Stepper label="今天可用时间" value={value} onChange={setValue} min={15} max={600} step={15} format={duration} />
        </Row>
      </Column>
    </Sheet>
  );
}

export function WeekOverview() {
  const schedule = useSchedule();
  const courses = useCourses();
  const color = (id: string) => courses.data?.find((c) => c.id === id)?.color ?? 0;
  if (schedule.isLoading || !schedule.data) return <Column gap={8}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={32} />)}</Column>;
  const max = Math.max(...schedule.data.days.map((d) => Math.max(d.minutes_available, d.minutes_planned)), 60);
  return (
    <div className={css.week}>
      {schedule.data.days.map((d) => (
        <div key={d.date} className={cx(css.day, d.date === todayIso() && css.today)}>
          <span className={css.dayName}><strong>{relativeDay(d.date).length <= 2 ? relativeDay(d.date) : weekday(d.date)}</strong>{shortDate(d.date)}</span>
          <div className={css.dayBar} style={{ width: `${Math.max(12, (d.minutes_available / max) * 100)}%` }} aria-label={`${relativeDay(d.date)}：安排 ${d.minutes_planned} 分钟`}>
            {d.tasks.map((t) => <span key={t.id} style={{ flex: t.minutes, background: `var(--course-${color(t.course_id) % 8})`, opacity: t.status === 'done' ? 0.4 : 1 }} />)}
          </div>
          {d.exams.length > 0
            ? d.exams.map((e) => <span key={e.course_id} className={css.exam} style={{ color: `var(--course-${e.color % 8})` }}><Icon name="flag" size={16} />{e.name}</span>)
            : <Text variant="caption" tone="tertiary" as="span">{d.minutes_planned ? `${d.minutes_planned} 分` : ''}</Text>}
        </div>
      ))}
      <Row justify="end"><Button variant="text" size="sm" to="/schedule" iconRight="chevronRight">{s.schedule.title}</Button></Row>
    </div>
  );
}

export function AllDone({ tomorrow, onQuick }: { tomorrow: Task[]; onQuick: () => void }) {
  const courses = useCourses();
  return (
    <Card>
      <div className={css.done}>
        <Ring value={1} size={64} stroke={6} color="var(--success)" label="今天的任务全部完成"><Icon name="check" tone="success" size={28} /></Ring>
        <Text variant="h3">{s.today.allDone}</Text>
        {tomorrow.length > 0 && (
          <Column gap={4} align="center">
            <Text variant="caption" tone="tertiary">{s.today.tomorrow}</Text>
            {tomorrow.map((t) => <Text key={t.id} variant="bodySm" tone="secondary">{courses.data?.find((c) => c.id === t.course_id)?.name} · {t.title}</Text>)}
          </Column>
        )}
        <Button variant="primary" icon="quick" onClick={onQuick}>{s.today.moreQuick}</Button>
      </div>
    </Card>
  );
}

export function MockSheet({ task, onConfirm, onCancel }: { task: Task | null; onConfirm: () => void; onCancel: () => void }) {
  const hub = usePractice(task?.course_id ?? null);
  return (
    <Sheet open={!!task} onClose={onCancel} title={s.sessionKind.mock} footer={<><Button variant="neutral" onClick={onCancel}>{s.action.cancel}</Button><Button variant="primary" icon="play" onClick={onConfirm}>{s.action.start}</Button></>}>
      {hub.data ? (
        <Column gap={8}>
          <Text variant="h2">{hub.data.mock.count} 道题 · {duration(hub.data.mock.minutes)}</Text>
          <Text tone="secondary">按考试形式出一整套，计时作答。题型分布依据：{s.basis[hub.data.mock.basis]}。</Text>
        </Column>
      ) : <Skeleton height={48} />}
    </Sheet>
  );
}

export function EmptyToday() {
  return (
    <Card>
      <Column gap={16} align="center" padding={24}>
        <Text tone="secondary">还没有课程</Text>
        <Row gap={8} wrap justify="center">
          <Button variant="primary" icon="plus" to="/courses/new">{s.today.empty}</Button>
          <Link to="/courses" style={{ alignSelf: 'center' }}><Text tone="accent" as="span">{s.today.sample}</Text></Link>
        </Row>
      </Column>
    </Card>
  );
}
