// 任务卡：课程色条、类型图标、名称、时长、完成勾（07 第 5 节）。勾掉：描边画出 → 高度收起（M2）。
import { useRef, useState, type PointerEvent } from 'react';
import { Link } from 'react-router';
import type { Countdown, Task, TaskKind } from '../api/types';
import { cx } from '../lib/cx';
import { duration } from '../lib/format';
import { reducedMotion } from '../lib/motion';
import { s } from '../strings/zh-CN';
import { Tag } from './Chip';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Menu, type MenuItem } from './Sheet';
import css from './task.module.css';

const KIND_ICON: Record<TaskKind, IconName> = { learn: 'learn', practice: 'quick', review: 'review', mock: 'mock', mistakes: 'mistakes' };

export function TaskCard({ task, courseName, color, onStart, onDone, menu, transitionName, highlight }: {
  task: Task;
  courseName: string;
  color: number;
  onStart: () => void;
  onDone?: () => void;
  menu?: MenuItem[];
  transitionName?: string;
  highlight?: boolean;
}) {
  const [checked, setChecked] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menuOpen, setMenuOpen] = useState(0);
  const done = task.status !== 'todo';
  const check = () => {
    if (!onDone || checked) return;
    setChecked(true);
    if (reducedMotion()) { onDone(); return; }
    setTimeout(() => setLeaving(true), 220);
    setTimeout(onDone, 480);
  };
  const longPress = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !menu) return;
      timer.current = setTimeout(() => setMenuOpen((n) => n + 1), 500);
    },
    onPointerUp: () => timer.current && clearTimeout(timer.current),
    onPointerLeave: () => timer.current && clearTimeout(timer.current),
  };
  const tint = `color-mix(in srgb, var(--course-${color % 8}) 12%, transparent)`;
  return (
    <div className={cx(css.collapse, leaving && css.leaving)}>
      <div>
        <div className={cx(css.task, done && css.doneTask, highlight && css.highlightTask)} style={transitionName ? { viewTransitionName: transitionName } : undefined} {...longPress}>
          <span className={css.strip} style={{ background: `var(--course-${color % 8})` }} aria-hidden />
          <button type="button" className={css.main} onClick={onStart} aria-label={`${s.action.start}：${task.title}，${courseName}，${duration(task.minutes)}`}>
            <span className={css.kind} style={{ background: tint, color: `var(--course-${color % 8})` }}><Icon name={KIND_ICON[task.kind]} size={20} /></span>
            <span className={css.body}>
              <span className={css.title}>{task.title}</span>
              <span className={css.meta}>
                <span>{courseName}</span><span aria-hidden>·</span><span>{duration(task.minutes)}</span>
                {task.progress && task.progress.total > 1 && <><span aria-hidden>·</span><span>{task.progress.done}/{task.progress.total}</span></>}
                {task.moved_from && <Tag tone="warning">顺延</Tag>}
                {task.pinned && !task.moved_from && <Icon name="pin" size={16} tone="tertiary" label="已固定" />}
              </span>
            </span>
          </button>
          {menu && <Menu items={menu} note={task.reason} label={s.action.more} openKey={menuOpen} />}
          {onDone && !done && (
            <button type="button" className={cx(css.check, checked && css.checked)} onClick={check} aria-label={`${s.action.done}：${task.title}`}>
              <svg className={css.checkCircle} viewBox="0 0 26 26" aria-hidden>
                <circle cx="13" cy="13" r="11.5" fill="none" strokeWidth="1.5" />
                <path d="M8 13.5l3.3 3.2L18.2 10" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {done && <span className={css.check}><Icon name="checkCircle" tone="success" label={s.today.done} /></span>}
        </div>
      </div>
    </div>
  );
}

export function CountdownPill({ countdown, to }: { countdown: Countdown; to: string }) {
  const color = `var(--course-${countdown.color % 8})`;
  return (
    <Link to={to} className={cx(css.pill, countdown.urgent && css.pillUrgent)} style={countdown.urgent ? { background: color } : undefined} aria-label={`${countdown.name}，还有 ${countdown.days_left} 天考试`}>
      <span className={css.dot} style={{ background: color }} aria-hidden />
      <span>{countdown.name}</span>
      <strong>{countdown.days_left === 0 ? '今天' : `${countdown.days_left}天`}</strong>
    </Link>
  );
}
