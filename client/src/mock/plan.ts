// 今天与日程：09 第 5.1 节的规则（代码规则，不交给模型）的演示实现。
import type * as T from '../api/types';
import { courseView, kpStates, LEVEL_WEIGHT } from './course';
import { addDays, byId, daysBetween, db, today, uid, type CourseRow, type KpRow, type TaskRow, type UserRow } from './db';
import type { Tracker } from './undo';

const HORIZON = 14;
const LEVEL_LABEL: Record<T.Level, string> = { emphasized: '老师强调', conflict: '老师强调', mentioned: '老师提到过', none: '课件内容', excluded: '老师说不考' };
const STATE_LABEL: Record<T.KpState, string> = { new: '还没学', learned: '学过还没练', shaky: '还不熟', mastered: '已掌握' };

export function activeCourses(user: UserRow, date = today()) {
  return db.courses.filter((c) => c.user_id === user.id && c.ingested && (!c.exam_date || c.exam_date >= date));
}

function urgency(course: CourseRow, date: string) {
  if (!course.exam_date) return 0.5;
  const d = daysBetween(date, course.exam_date);
  if (d <= 2) return 4;
  return 1 + 6 / d;
}

const round5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);

export function availableOn(user: UserRow, date: string) {
  if (date === today() && user.today_minutes?.date === date) return user.today_minutes.minutes;
  return user.day_minutes?.[date] ?? user.settings.daily_minutes;
}

/** 生成或补齐今天起 14 天的任务。保留已完成、跳过、固定和顺延的任务。 */
export function planUser(user: UserRow, force = false) {
  const d0 = today();
  if (user.planned_on !== d0) {
    const late = db.tasks.filter((t) => t.user_id === user.id && t.date < d0 && t.status === 'todo');
    const yesterday = addDays(d0, -1);
    const carried = late.filter((t) => t.date === yesterday && t.kind !== 'mock');
    for (const t of late) {
      if (carried.includes(t)) {
        t.moved_from = t.date;
        t.date = d0;
        t.reason = '昨天没做完';
      } else t.status = 'skipped';
    }
    user.notice = carried.length ? { date: d0, text: `昨天有 ${carried.length} 项没做完，已排进今天`, shown: false } : null;
    user.planned_on = d0;
    force = true;
  }
  if (!force && db.tasks.some((t) => t.user_id === user.id && t.date >= d0)) return;

  db.tasks = db.tasks.filter((t) => !(t.user_id === user.id && t.date >= d0 && t.status === 'todo' && !t.pinned && !t.moved_from));
  const courses = activeCourses(user, d0);
  const queues = new Map<T.ID, KpRow[]>();
  const states = new Map<T.ID, Map<T.ID, T.KpState>>();
  const kept = db.tasks.filter((t) => t.user_id === user.id && t.date >= d0);
  const planned = new Set(kept.flatMap((t) => t.kp_ids));
  for (const c of courses) {
    const s = kpStates(c.id);
    states.set(c.id, s);
    queues.set(c.id, db.kps
      .filter((k) => k.course_id === c.id && k.level !== 'excluded' && s.get(k.id) === 'new' && !planned.has(k.id))
      .sort((a, b) => LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] || a.order - b.order));
  }

  for (let i = 0; i < HORIZON; i += 1) {
    const date = addDays(d0, i);
    const onDay = db.tasks.filter((t) => t.user_id === user.id && t.date === date);
    let budget = availableOn(user, date) - onDay.reduce((sum, t) => sum + t.minutes, 0);
    const open = courses.filter((c) => !c.exam_date || c.exam_date >= date);
    const need = new Map(open.map((c) => {
      const s = states.get(c.id)!;
      const remaining = db.kps.filter((k) => k.course_id === c.id && s.get(k.id) !== 'mastered').reduce((sum, k) => sum + LEVEL_WEIGHT[k.level], 0);
      return [c.id, urgency(c, date) * Math.max(remaining, 1)];
    }));
    const total = [...need.values()].reduce((a, b) => a + b, 0) || 1;
    const ordered = [...open].sort((a, b) => urgency(b, date) - urgency(a, date));
    let order = onDay.length;
    for (const course of ordered) {
      if (budget < 10) break;
      let share = Math.min(budget, Math.max(15, round5((availableOn(user, date) * need.get(course.id)!) / total)));
      if (course.daily_cap_min) share = Math.min(share, course.daily_cap_min);
      const push = (task: Omit<TaskRow, 'id' | 'user_id' | 'course_id' | 'date' | 'status' | 'moved_from' | 'pinned' | 'session_id'>) => {
        db.tasks.push({ id: uid('t'), user_id: user.id, course_id: course.id, date, status: 'todo', moved_from: null, pinned: false, session_id: null, ...task });
        share -= task.minutes;
        budget -= task.minutes;
        order += 1;
      };
      const s = states.get(course.id)!;
      const daysLeft = course.exam_date ? daysBetween(date, course.exam_date) : null;
      if (i === 0) {
        const due = db.kps.filter((k) => k.course_id === course.id && k.due && k.due <= date && s.get(k.id) !== 'new');
        if (due.length) push({ kind: 'review', title: `到期复习 ${Math.min(due.length * 2, 20)} 道`, minutes: round5(due.length * 3), reason: '按记忆规律到期', kp_ids: due.map((k) => k.id), progress: null });
      }
      if (daysLeft === 1) {
        push({ kind: 'mock', title: '模拟卷', minutes: Math.min(course.format.duration_min ?? 90, 90), reason: '明天考试，做一套整卷', kp_ids: [], progress: null });
        continue;
      }
      const queue = queues.get(course.id)!;
      while (share >= 10 && queue.length) {
        const first = queue[0]!;
        const group = queue.filter((k) => k.topic_id === first.topic_id).slice(0, 3);
        const topic = byId('topics', first.topic_id);
        const perKp = topic ? Math.max(5, Math.round(topic.minutes / Math.max(1, db.kps.filter((k) => k.topic_id === topic.id).length))) : 10;
        const minutes = round5(perKp * group.length);
        if (minutes > share + 10 && group.length > 1) group.splice(1);
        for (const kp of group) queue.splice(queue.indexOf(kp), 1);
        push({
          kind: 'learn', title: group.length > 1 ? `${topic?.title ?? first.title}` : first.title,
          minutes: round5(perKp * group.length), reason: `${LEVEL_LABEL[first.level]} · ${STATE_LABEL[s.get(first.id) ?? 'new']}`,
          kp_ids: group.map((k) => k.id), progress: { done: 0, total: group.length },
        });
      }
      if (share >= 10) {
        const shaky = db.kps.filter((k) => k.course_id === course.id && s.get(k.id) === 'shaky').length;
        push({ kind: 'practice', title: '快练 5 道', minutes: 10, reason: shaky ? `有 ${shaky} 个知识点不稳` : '巩固学过的知识点', kp_ids: [], progress: null });
      }
    }
    void order;
  }
}

function taskView(t: TaskRow): T.Task {
  const { user_id: _u, ...rest } = t;
  if (rest.kind === 'learn' && rest.kp_ids.length) {
    const understood = rest.kp_ids.filter((id) => byId('kps', id)?.understood_at).length;
    rest.progress = { done: understood, total: rest.kp_ids.length };
  }
  return rest;
}

const kindRank: Record<T.TaskKind, number> = { review: 0, mistakes: 1, learn: 2, practice: 3, mock: 4 };
function sortTasks(tasks: TaskRow[], courses: CourseRow[], date: string) {
  const rank = new Map(courses.map((c) => [c.id, urgency(c, date)]));
  return [...tasks].sort((a, b) =>
    Number(!!b.moved_from) - Number(!!a.moved_from) ||
    (rank.get(b.course_id) ?? 0) - (rank.get(a.course_id) ?? 0) ||
    kindRank[a.kind] - kindRank[b.kind]);
}

export function todayView(user: UserRow): T.Today {
  planUser(user);
  const d0 = today();
  const courses = db.courses.filter((c) => c.user_id === user.id);
  const mine = db.tasks.filter((t) => t.user_id === user.id && t.date === d0);
  const todo = sortTasks(mine.filter((t) => t.status === 'todo'), courses, d0);
  const done = mine.filter((t) => t.status !== 'todo');
  const notice = user.notice && user.notice.date === d0 && !user.notice.shown ? user.notice.text : null;
  if (user.notice && notice) user.notice.shown = true;
  const countdowns = courses
    .filter((c) => c.exam_date && c.exam_date >= d0)
    .map((c) => ({ course_id: c.id, name: c.name, color: c.color, exam_date: c.exam_date!, days_left: daysBetween(d0, c.exam_date!), urgent: daysBetween(d0, c.exam_date!) <= 3 }))
    .sort((a, b) => a.days_left - b.days_left);
  return {
    date: d0,
    briefing: user.settings.briefing ? briefing(user, todo, countdowns) : null,
    minutes_available: availableOn(user, d0),
    minutes_planned: mine.filter((t) => t.status !== 'skipped').reduce((s, t) => s + t.minutes, 0),
    progress: { done: done.filter((t) => t.status === 'done').length, total: mine.filter((t) => t.status !== 'skipped').length },
    countdowns,
    resume: user.resume,
    tasks: todo.map(taskView),
    done: done.map(taskView),
    notice,
    tomorrow: todo.length === 0 ? sortTasks(db.tasks.filter((t) => t.user_id === user.id && t.date === addDays(d0, 1)), courses, addDays(d0, 1)).slice(0, 3).map(taskView) : [],
  };
}

function briefing(user: UserRow, todo: TaskRow[], countdowns: T.Countdown[]): string | null {
  if (!countdowns.length && !todo.length) return null;
  const parts: string[] = [];
  const first = countdowns[0];
  if (first) parts.push(first.days_left <= 3 ? `${first.name}还有 ${first.days_left} 天，今天优先它。` : `离最近的考试（${first.name}）还有 ${first.days_left} 天。`);
  const learn = todo.find((t) => t.kind === 'learn');
  if (learn) parts.push(`先学“${learn.title}”，再做一组快练。`);
  const review = todo.find((t) => t.kind === 'review');
  if (review) parts.push(`${byId('courses', review.course_id)?.name ?? ''}有${review.title.replace('到期复习', '')}到期了。`);
  void user;
  return parts.slice(0, 3).join('');
}

export function scheduleView(user: UserRow, from?: string, to?: string): T.Schedule {
  planUser(user);
  const start = from ?? today();
  const end = to ?? addDays(start, 6);
  const courses = db.courses.filter((c) => c.user_id === user.id);
  const days: T.ScheduleDay[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const tasks = sortTasks(db.tasks.filter((t) => t.user_id === user.id && t.date === date && t.status !== 'skipped'), courses, date);
    days.push({
      date,
      minutes_available: availableOn(user, date),
      minutes_planned: tasks.reduce((s, t) => s + t.minutes, 0),
      tasks: tasks.map(taskView),
      exams: courses.filter((c) => c.exam_date === date).map((c) => ({ course_id: c.id, name: c.name, color: c.color })),
    });
  }
  return { from: start, to: end, daily_minutes: user.settings.daily_minutes, intensity: user.settings.intensity, days };
}

/** 可撤销的重排：先给今天起的任务拍快照，重排后按 id 找出新建的任务（撤销时删掉） */
export function replanTracked(user: UserRow, t: Tracker) {
  const before = db.tasks.filter((x) => x.user_id === user.id && x.date >= today());
  for (const task of before) t.before('tasks', task);
  const ids = new Set(db.tasks.map((x) => x.id));
  planUser(user, true);
  for (const task of db.tasks) if (!ids.has(task.id)) t.added('tasks', task);
}

export function taskById(id: T.ID) {
  return db.tasks.find((t) => t.id === id);
}

export { taskView, courseView };
