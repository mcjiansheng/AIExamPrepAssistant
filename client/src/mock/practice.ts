// 练习：选题、先出后核的题目状态、判分、提示阶梯、报错、结果、错题本、学情（09 第 7、8 节）。
import type * as T from '../api/types';
import { T as text } from './content';
import { bankForKp, chapterView, kpBrief, kpStates, LEVEL_WEIGHT, readiness, refView, stateOf, weakKps } from './course';
import {
  addDays, byId, daysBetween, db, nowIso, today, uid,
  type BankRow, type CourseRow, type ItemRow, type KpRow, type SessionRow, type UserRow,
} from './db';
import { ApiErr } from './errors';

const KIND_LABEL: Record<T.SessionKind, string> = { quick: '快练', kp: '按知识点练', review: '到期复习', mistakes: '错题重做', mock: '模拟卷' };
const INTENSITY: Record<T.Intensity, number> = { easy: 1.3, standard: 1, sprint: 0.7 };

export function hasAi(user: UserRow) {
  return db.providers.some((p) => p.user_id === user.id && p.status === 'ok');
}
export function requireAi(user: UserRow, course: CourseRow | null) {
  if (course?.sample) return;
  if (!hasAi(user)) throw new ApiErr(409, 'ai_required', '还没有连接 AI 模型');
}

function userCourses(user: UserRow) {
  return db.courses.filter((c) => c.user_id === user.id && c.ingested);
}

function answeredCorrect(bankId: T.ID) {
  return db.events.some((e) => e.bank_id === bankId && e.outcome === 'correct');
}

function pickBank(kp: KpRow, used: Set<T.ID>, types?: T.QuestionType[]): BankRow | undefined {
  const pool = bankForKp(kp.id).filter((b) => !used.has(b.id) && (!types || types.includes(b.type)));
  return pool.find((b) => b.authored && !answeredCorrect(b.id)) ?? pool.find((b) => b.type === 'single' && !answeredCorrect(b.id)) ?? pool.find((b) => !answeredCorrect(b.id)) ?? pool[0];
}

function quickCandidates(courses: CourseRow[]) {
  const d0 = today();
  const out: { kp: KpRow; weight: number }[] = [];
  for (const c of courses) {
    const s = kpStates(c.id);
    for (const kp of db.kps.filter((k) => k.course_id === c.id && k.level !== 'excluded')) {
      const state = s.get(kp.id)!;
      const due = kp.due && kp.due <= d0;
      if (state === 'mastered' && !due) continue;
      const w = (state === 'shaky' ? 3 : due ? 2.5 : state === 'learned' ? 2 : 1) + LEVEL_WEIGHT[kp.level] / 4;
      out.push({ kp, weight: w });
    }
  }
  return out.sort((a, b) => b.weight - a.weight || a.kp.order - b.kp.order);
}

export function createSession(user: UserRow, input: T.NewSession): SessionRow {
  const course = input.course_id ? byId('courses', input.course_id) : null;
  if (input.course_id && (!course || course.user_id !== user.id)) throw new ApiErr(404, 'not_found', '课程不存在');
  const courses = course ? [course] : userCourses(user);
  const used = new Set<T.ID>();
  let picked: BankRow[] = [];
  const kind = input.kind;
  if (kind === 'quick') {
    const count = input.count ?? 5;
    for (const { kp } of quickCandidates(courses)) {
      if (picked.length >= count) break;
      const b = pickBank(kp, used, ['single', 'fill', 'calc', 'short']);
      if (b) { picked.push(b); used.add(b.id); }
    }
  } else if (kind === 'kp') {
    const kp = input.kp_id ? byId('kps', input.kp_id) : undefined;
    if (!kp) throw new ApiErr(404, 'not_found', '知识点不存在');
    picked = bankForKp(kp.id).slice(0, input.count ?? 3);
  } else if (kind === 'review') {
    const d0 = today();
    const due = courses.flatMap((c) => db.kps.filter((k) => k.course_id === c.id && k.due && k.due <= d0));
    for (const kp of due.slice(0, input.count ?? 20)) {
      const b = pickBank(kp, used);
      if (b) { picked.push(b); used.add(b.id); }
    }
  } else if (kind === 'mistakes') {
    const ids = input.question_ids?.length ? input.question_ids
      : db.mistakes.filter((m) => m.user_id === user.id && !m.removed && (!course || m.course_id === course.id)).map((m) => m.bank_id);
    picked = ids.map((id) => byId('bank', id)).filter((b): b is BankRow => !!b).slice(0, input.count ?? 10);
  } else if (kind === 'mock') {
    if (!course) throw new ApiErr(400, 'bad_request', '模拟卷需要指定课程');
    const kps = db.kps.filter((k) => k.course_id === course.id && k.level !== 'excluded')
      .sort((a, b) => LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] || a.order - b.order);
    for (const { type, count } of course.format.types) {
      let n = 0;
      for (const kp of kps) {
        if (n >= count) break;
        const b = bankForKp(kp.id).find((x) => x.type === type && !used.has(x.id) && (type !== 'single' || x.authored || n >= 3));
        if (b) { picked.push(b); used.add(b.id); n += 1; }
      }
      for (const kp of kps) {
        if (n >= count) break;
        const b = bankForKp(kp.id).find((x) => x.type === type && !used.has(x.id));
        if (b) { picked.push(b); used.add(b.id); n += 1; }
      }
    }
  }
  if (!picked.length) throw new ApiErr(409, 'conflict', kind === 'mistakes' ? '错题本里没有题' : kind === 'review' ? '今天没有到期的题' : '范围里没有可以出题的知识点');
  if (courses.some((c) => !c.sample)) requireAi(user, course ?? null);
  if (kind === 'mock' && hasAi(user) && !input.confirm) {
    const tokens = picked.length * 2_800;
    if (tokens > user.limits.confirm_tokens) {
      throw new ApiErr(409, 'needs_confirmation', `这套题预计要用约 ${Math.round(tokens / 1000)} 千 token`, {
        estimate: { tokens_min: Math.round(tokens * 0.8), tokens_max: Math.round(tokens * 1.2), cost_min: +(tokens * 0.8 * 4e-6).toFixed(2), cost_max: +(tokens * 1.2 * 4e-6).toFixed(2), needs_confirm: true },
      });
    }
  }
  const now = Date.now();
  const session: SessionRow = {
    id: uid('s'), user_id: user.id, kind, course_id: course?.id ?? null,
    title: `${course?.name ?? '全部课程'} · ${KIND_LABEL[kind]}`, status: 'preparing', created_at: nowIso(), started_at: null,
    finished_at: null, time_limit_min: kind === 'mock' ? course?.format.duration_min ?? 120 : null, position: 0,
    task_id: input.task_id ?? null, job_id: null, result: null,
  };
  const job = {
    id: uid('j'), user_id: user.id, kind: 'session' as const, status: 'running' as const, progress: 0, stage: '出题中',
    error: null, course_id: session.course_id, target_id: session.id, result: null, estimate: null, created_at: nowIso(), due: 0, payload: {},
  };
  session.job_id = job.id;
  db.jobs.push(job);
  db.sessions.push(session);
  let delay = 500;
  picked.forEach((b, index) => {
    const reused = db.items.some((it) => it.bank_id === b.id && it.check === 'passed');
    const ready_at = reused ? now + 150 : now + delay;
    if (!reused) delay += kind === 'mock' ? 700 : 900;
    db.items.push({
      id: uid('qi'), session_id: session.id, bank_id: b.id, index, version: 1, status: 'pending',
      check: 'checking', check_note: null, replaced: false, hints: [], peeked: false, attempt: null,
      ready_at, check_at: reused ? ready_at : ready_at + 2400 + (index % 3) * 700,
    });
  });
  if (session.task_id) {
    const task = db.tasks.find((t) => t.id === session.task_id);
    if (task) task.session_id = session.id;
  }
  return session;
}

export function questionView(item: ItemRow): T.Question {
  const b = byId('bank', item.bank_id)!;
  const kp = byId('kps', b.kp_id);
  const reveal = !!item.attempt || item.peeked;
  return {
    id: item.id, bank_id: b.id, index: item.index, version: item.version, type: b.type,
    status: item.status, check: item.check, check_note: item.check_note, replaced: item.replaced, score: b.score,
    kp: { id: b.kp_id, title: kp?.title ?? '' }, course_id: b.course_id,
    stem: item.status === 'pending' ? [] : b.stem, options: item.status === 'pending' ? null : b.options,
    refs: b.refs.map((r) => refView(r)), hints: item.hints, peeked: item.peeked, attempt: item.attempt,
    solution: reveal ? solutionOf(b) : null,
  };
}

export function bankQuestion(b: BankRow): T.Question {
  const kp = byId('kps', b.kp_id);
  return {
    id: b.id, bank_id: b.id, index: 0, version: 1, type: b.type, status: 'ready', check: 'passed', check_note: null,
    replaced: false, score: b.score, kp: { id: b.kp_id, title: kp?.title ?? '' }, course_id: b.course_id, stem: b.stem,
    options: b.options, refs: b.refs.map((r) => refView(r)), hints: [], peeked: false, attempt: null, solution: solutionOf(b),
  };
}

function solutionOf(b: BankRow): T.Solution {
  return {
    answer: b.answer,
    steps: b.steps.map((blocks, i) => ({ n: i + 1, blocks, refs: i === 0 ? b.refs.map((r) => refView(r)) : [] })),
    rubric: b.rubric,
  };
}

export function sessionView(s: SessionRow): T.Session {
  const items = db.items.filter((i) => i.session_id === s.id).sort((a, b) => a.index - b.index);
  const job = s.job_id ? db.jobs.find((j) => j.id === s.job_id) : undefined;
  const counted = items.filter((i) => i.status === 'ready' && i.check !== 'flagged');
  return {
    id: s.id, kind: s.kind, course_id: s.course_id, title: s.title, status: s.status, created_at: s.created_at,
    started_at: s.started_at, finished_at: s.finished_at, time_limit_min: s.time_limit_min, position: s.position,
    task_id: s.task_id, job: job ? (({ user_id: _u, due: _d, payload: _p, ...rest }) => rest)(job) : null,
    questions: items.map(questionView),
    score: s.status === 'finished' ? s.result?.score ?? null : null,
    total: counted.reduce((sum, i) => sum + (byId('bank', i.bank_id)?.score ?? 0), 0),
  };
}

export function summaryView(s: SessionRow): T.SessionSummary {
  const items = db.items.filter((i) => i.session_id === s.id && i.status !== 'hidden' && i.status !== 'failed');
  const course = s.course_id ? byId('courses', s.course_id) : null;
  return {
    id: s.id, kind: s.kind, course_id: s.course_id, course_name: course?.name ?? null, title: s.title, status: s.status,
    created_at: s.created_at, finished_at: s.finished_at, question_count: items.length,
    answered: items.filter((i) => i.attempt).length, score: s.result?.score ?? null,
    total: s.result?.total ?? items.reduce((sum, i) => sum + (byId('bank', i.bank_id)?.score ?? 0), 0),
  };
}

// —— 判分 ——
const normal = (s: string) => s.replace(/\s+/g, '').replace(/[²]/g, '^2').replace(/[，,。]/g, '').toLowerCase();
function sameAnswer(response: string, b: BankRow) {
  const r = normal(response);
  if (!r) return false;
  const candidates = [b.key, b.answer].filter(Boolean).map((x) => normal(x!));
  if (candidates.includes(r)) return true;
  const num = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  const rn = num(r.replace(/(次|个|道)$/u, ''));
  return rn !== null && candidates.some((c) => num(c.replace(/(次|个|道)$/u, '')) === rn);
}

function itemOwned(user: UserRow, qid: T.ID) {
  const item = byId('items', qid);
  const session = item ? byId('sessions', item.session_id) : undefined;
  if (!item || !session || session.user_id !== user.id) throw new ApiErr(404, 'not_found', '题目不存在');
  return { item, session, bank: byId('bank', item.bank_id)! };
}

function record(user: UserRow, item: ItemRow, session: SessionRow, b: BankRow, outcome: 'correct' | 'wrong' | 'partial', reason: string) {
  const kp = byId('kps', b.kp_id)!;
  const before = kpStates(kp.course_id).get(kp.id)!;
  const counted = !item.peeked && item.check !== 'flagged';
  db.events.push({ id: uid('ev'), user_id: user.id, kp_id: kp.id, bank_id: b.id, item_id: item.id, session_id: session.id, outcome, counted, hinted: item.hints.length > 0, at: nowIso() });
  if (counted) updateStability(user, kp, outcome, item.hints.length > 0);
  let mistakeAdded = false;
  const existing = db.mistakes.find((m) => m.user_id === user.id && m.bank_id === b.id);
  if (outcome !== 'correct') {
    if (existing) {
      existing.wrong_count += 1; existing.correct_streak = 0; existing.streak_sessions = []; existing.removed = false;
      existing.last_wrong_at = nowIso(); existing.reason = reason;
    } else {
      db.mistakes.push({ user_id: user.id, bank_id: b.id, course_id: b.course_id, wrong_count: 1, correct_streak: 0, last_wrong_at: nowIso(), reason, streak_sessions: [], removed: false });
    }
    mistakeAdded = true;
  } else if (existing && !existing.removed && !existing.streak_sessions.includes(session.id)) {
    existing.correct_streak += 1;
    existing.streak_sessions.push(session.id);
    if (existing.correct_streak >= 2) existing.removed = true;
  }
  const after = kpStates(kp.course_id).get(kp.id)!;
  const mastery = before !== after ? [{ kp_id: kp.id, title: kp.title, from: before, to: after }] : [];
  logReadiness(kp.course_id);
  return { mastery, mistakeAdded };
}

function updateStability(user: UserRow, kp: KpRow, outcome: 'correct' | 'wrong' | 'partial', hinted: boolean) {
  if (kp.stability === null) kp.stability = outcome === 'correct' ? 2 : 0.5;
  else if (outcome === 'correct') kp.stability *= hinted ? 1.5 : 2.5;
  else if (outcome === 'partial') kp.stability *= 1.5;
  else kp.stability = Math.max(0.5, kp.stability * 0.5);
  let interval = kp.stability * INTENSITY[user.settings.intensity];
  const course = byId('courses', kp.course_id);
  if (course?.exam_date) interval = Math.min(interval, Math.max(1, Math.floor(daysBetween(today(), course.exam_date) / 2)));
  kp.due = addDays(today(), Math.max(1, Math.round(interval)));
}

export function logReadiness(courseId: T.ID) {
  const r = readiness(courseId);
  const ratio = r.total ? r.mastered / r.total : 0;
  const d0 = today();
  const row = db.readiness.find((x) => x.course_id === courseId && x.date === d0);
  if (row) row.ratio = ratio;
  else db.readiness.push({ course_id: courseId, date: d0, ratio });
}

export function attempt(user: UserRow, qid: T.ID, response: string | null): T.AttemptResult {
  const { item, session, bank } = itemOwned(user, qid);
  if (item.attempt) throw new ApiErr(409, 'conflict', '这道题已经答过了');
  if (item.status !== 'ready') throw new ApiErr(409, 'conflict', '这道题还没出好');
  const at = nowIso();
  let mastery: T.MasteryChange[] = [];
  let mistakeAdded = false;
  if (bank.type === 'single' || bank.type === 'fill') {
    const correct = response !== null && (bank.type === 'single' ? response === bank.key : sameAnswer(response, bank));
    item.attempt = { response, state: 'graded', correct, score: correct ? bank.score : 0, marks: null, answered_at: at };
    const reason = response === null ? '没有作答' : bank.type === 'single' ? `选了 ${response}` : `填了 ${response}`;
    ({ mastery, mistakeAdded } = record(user, item, session, bank, correct ? 'correct' : 'wrong', reason));
  } else {
    const finalOk = bank.type === 'calc' && response !== null && !!bank.key && sameAnswer(response, bank);
    const marks = finalOk && bank.rubric ? Object.fromEntries(bank.rubric.map((r) => [r.id, 'full' as T.Mark])) : null;
    item.attempt = { response, state: 'needs_self_grade', correct: bank.type === 'calc' && bank.key ? finalOk : null, score: finalOk ? bank.score : null, marks, answered_at: at };
  }
  if (session.status === 'preparing') session.status = 'active';
  return { question: questionView(item), mastery, mistake_added: mistakeAdded };
}

export function grade(user: UserRow, qid: T.ID, marks: Record<string, T.Mark>): T.AttemptResult {
  const { item, session, bank } = itemOwned(user, qid);
  if (!item.attempt) throw new ApiErr(409, 'conflict', '先提交答案再自评');
  const rubric = bank.rubric ?? [];
  const score = rubric.reduce((sum, r) => sum + (marks[r.id] === 'full' ? r.score : marks[r.id] === 'partial' ? r.score / 2 : 0), 0);
  const alreadyGraded = item.attempt.state === 'graded';
  item.attempt = { ...item.attempt, state: 'graded', marks, score, correct: score >= bank.score ? true : score === 0 ? false : null };
  let mastery: T.MasteryChange[] = [];
  let mistakeAdded = false;
  if (!alreadyGraded) {
    const outcome = score >= bank.score ? 'correct' : score === 0 ? 'wrong' : 'partial';
    ({ mastery, mistakeAdded } = record(user, item, session, bank, outcome, outcome === 'partial' ? '自评：部分得分' : '自评：没有得分'));
  }
  return { question: questionView(item), mastery, mistake_added: mistakeAdded };
}

export function hint(user: UserRow, qid: T.ID, level: 1 | 2 | 3) {
  const { item, bank } = itemOwned(user, qid);
  const existing = item.hints.find((h) => h.level === level);
  if (existing) return { hint: existing, question: questionView(item) };
  const refs = bank.refs.map((r) => refView(r));
  const texts: Record<1 | 2 | 3, string> = {
    1: bank.hints[0],
    2: bank.hints[1],
    3: `答案：${bank.answer}。完整过程见下方解析。`,
  };
  const h: T.Hint = { level, text: texts[level], refs: level === 1 ? refs : [] };
  item.hints.push(h);
  if (level === 3) item.peeked = true;
  return { hint: h, question: questionView(item) };
}

export function report(user: UserRow, qid: T.ID) {
  const { item } = itemOwned(user, qid);
  item.status = 'hidden';
  db.events.filter((e) => e.item_id === item.id).forEach((e) => { e.counted = false; });
  return { question: questionView(item) };
}

export function finish(user: UserRow, s: SessionRow): T.Result {
  if (s.result) return s.result;
  const items = db.items.filter((i) => i.session_id === s.id);
  for (const i of items) if (i.status === 'pending') i.status = 'failed';
  const counted = items.filter((i) => i.status === 'ready' && i.check !== 'flagged');
  const total = counted.reduce((sum, i) => sum + (byId('bank', i.bank_id)?.score ?? 0), 0);
  const score = counted.reduce((sum, i) => sum + (i.attempt?.score ?? 0), 0);
  const correct = counted.filter((i) => i.attempt?.correct === true || (i.attempt?.score ?? 0) >= (byId('bank', i.bank_id)?.score ?? 1)).length;
  const finished = nowIso();
  s.status = 'finished';
  s.finished_at = finished;
  const started = Date.parse(s.started_at ?? s.created_at);
  const events = db.events.filter((e) => e.session_id === s.id);
  const kpIds = [...new Set(events.map((e) => e.kp_id))];
  const mastery: T.MasteryChange[] = [];
  const chapters = new Set<T.ID>();
  for (const id of kpIds) {
    const kp = byId('kps', id)!;
    const all = db.events.filter((e) => e.kp_id === id && e.counted);
    const from = stateOf(kp, all.filter((e) => e.session_id !== s.id));
    const to = stateOf(kp, all);
    if (from !== to) { mastery.push({ kp_id: id, title: kp.title, from, to }); chapters.add(kp.chapter_id); }
  }
  const course = s.course_id ? byId('courses', s.course_id) : byId('courses', byId('kps', kpIds[0] ?? '')?.course_id ?? '');
  const states = course ? kpStates(course.id) : new Map<T.ID, T.KpState>();
  const wrong = counted.filter((i) => i.attempt && (i.attempt.score ?? 0) < (byId('bank', i.bank_id)?.score ?? 0));
  const weakest = wrong.map((i) => byId('kps', byId('bank', i.bank_id)!.kp_id)!).find(Boolean);
  const review = wrong.length === 0
    ? { text: counted.length ? '这组题全部做对了。可以去学下一个知识点，或者挑战一套模拟卷。' : '这次没有作答。', actions: [] as T.ReviewAction[] }
    : {
        text: `${wrong.length} 道没拿满分，集中在“${weakest?.title ?? ''}”。先把它再看一遍，再来几道同类题巩固。`,
        actions: weakest ? [
          { label: `学一遍${weakest.title}`, kind: 'kp' as const, kp_id: weakest.id, session: null },
          { label: '来 3 道同类题', kind: 'session' as const, kp_id: weakest.id, session: { kind: 'kp' as const, course_id: weakest.course_id, kp_id: weakest.id, count: 3 } },
        ] : [],
      };
  let task: T.Task | null = null;
  if (s.task_id) {
    const t = db.tasks.find((x) => x.id === s.task_id);
    if (t && t.status === 'todo') { t.status = 'done'; const { user_id: _u, ...rest } = t; task = rest; }
  }
  const result: T.Result = {
    session: sessionView(s), score, total, accuracy: counted.length ? correct / counted.length : 0,
    duration_sec: Math.max(30, Math.round((Date.parse(finished) - started) / 1000)), mastery,
    chapters: [...chapters].map((id) => chapterView(id, states)), mistakes: wrong.map(questionView),
    review: s.kind === 'kp' && wrong.length === 0 ? null : review, task,
  };
  s.result = result;
  result.session = sessionView(s);
  if (course) logReadiness(course.id);
  void user;
  return result;
}

export function practiceHub(user: UserRow, courseId: T.ID | null): T.PracticeHub {
  const courses = courseId ? db.courses.filter((c) => c.id === courseId) : userCourses(user);
  const d0 = today();
  const due = courses.flatMap((c) => db.kps.filter((k) => k.course_id === c.id && k.due && k.due <= d0)).length;
  const mistakes = db.mistakes.filter((m) => m.user_id === user.id && !m.removed && (!courseId || m.course_id === courseId)).length;
  const course = courseId ? byId('courses', courseId) : courses.filter((c) => c.exam_date).sort((a, b) => (a.exam_date! < b.exam_date! ? -1 : 1))[0];
  const mockCount = course ? course.format.types.reduce((s, t) => s + t.count, 0) : 0;
  return {
    course_id: courseId,
    quick: { count: 5, minutes: 10 },
    review: { count: Math.min(due * 2, 20), minutes: Math.max(5, due * 3) },
    mistakes: { count: mistakes },
    mock: { available: !!course, count: mockCount, minutes: course?.format.duration_min ?? 120, basis: course?.format.basis ?? 'default' },
    history: db.sessions.filter((s) => s.user_id === user.id && (!courseId || s.course_id === courseId))
      .filter((s) => !(s.title.endsWith('小测') && !db.items.some((i) => i.session_id === s.id && i.attempt)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20).map(summaryView),
  };
}

export function mistakesView(user: UserRow, courseId: T.ID | null): T.Mistake[] {
  return db.mistakes
    .filter((m) => m.user_id === user.id && !m.removed && (!courseId || m.course_id === courseId))
    .sort((a, b) => b.last_wrong_at.localeCompare(a.last_wrong_at))
    .map((m) => ({
      question: bankQuestion(byId('bank', m.bank_id)!), course_id: m.course_id, course_name: byId('courses', m.course_id)?.name ?? '',
      reason: m.reason, wrong_count: m.wrong_count, correct_streak: m.correct_streak, last_wrong_at: m.last_wrong_at,
    }));
}

export function similarSession(user: UserRow, bankId: T.ID): SessionRow {
  const b = byId('bank', bankId);
  if (!b) throw new ApiErr(404, 'not_found', '题目不存在');
  const other = bankForKp(b.kp_id).find((x) => x.id !== b.id) ?? b;
  return createSession(user, { kind: 'mistakes', course_id: b.course_id, question_ids: [other.id] });
}

export function insightView(course: CourseRow): T.Insight {
  const states = kpStates(course.id);
  const r = readiness(course.id, states);
  const ratio = r.total ? r.mastered / r.total : 0;
  const log = db.readiness.filter((x) => x.course_id === course.id).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  const first = log[0];
  const days = first ? Math.max(1, daysBetween(first.date, today())) : 1;
  const rate = first ? Math.max(0, (ratio - first.ratio) / days) : 0.03;
  const left = course.exam_date ? Math.max(0, daysBetween(today(), course.exam_date)) : 14;
  const projected = Math.min(1, ratio + rate * left);
  const tenths = Math.round(projected * 10);
  const verdict = projected >= 0.95 ? '按现在的速度，考前能把重点全部掌握'
    : tenths <= Math.round(ratio * 10) ? '照现在这样，考前重点掌握不会再增加，需要加快进度'
    : `按现在的速度，考前能掌握 ${tenths} 成重点`;
  const sessions = db.sessions.filter((s) => s.course_id === course.id && s.result);
  const practice = sessions.filter((s) => s.kind === 'quick' || s.kind === 'kp' || s.kind === 'mistakes').reduce((sum, s) => sum + Math.round((s.result?.duration_sec ?? 0) / 60), 0);
  const review = sessions.filter((s) => s.kind === 'review').reduce((sum, s) => sum + Math.round((s.result?.duration_sec ?? 0) / 60), 0);
  const mock = sessions.filter((s) => s.kind === 'mock').reduce((sum, s) => sum + Math.round((s.result?.duration_sec ?? 0) / 60), 0);
  const learn = db.tasks.filter((t) => t.course_id === course.id && t.kind === 'learn' && t.status === 'done').reduce((sum, t) => sum + t.minutes, 0);
  return {
    course_id: course.id, verdict,
    readiness: log.length ? log.map((x) => ({ date: x.date, ratio: x.ratio })) : [{ date: today(), ratio }],
    chapters: db.chapters.filter((c) => c.course_id === course.id).sort((a, b) => a.order - b.order).map((ch) => {
      const kps = db.kps.filter((k) => k.chapter_id === ch.id);
      const count = (s: T.KpState) => kps.filter((k) => states.get(k.id) === s).length;
      return { id: ch.id, title: ch.title, new: count('new'), learned: count('learned'), shaky: count('shaky'), mastered: count('mastered') };
    }),
    weak: weakKps(course.id, 5, states),
    minutes: { total: learn + practice + review + mock, learn, practice, review, mock },
  };
}

export function kpQuizSession(user: UserRow, kp: KpRow): SessionRow {
  const open = db.sessions.find((s) => s.user_id === user.id && s.kind === 'kp' && s.status !== 'finished' && db.items.some((i) => i.session_id === s.id && byId('bank', i.bank_id)?.kp_id === kp.id) && s.title.endsWith('小测'));
  if (open) return open;
  const bank = bankForKp(kp.id).slice(0, 3);
  const session = createSessionRaw(user, kp, bank);
  return session;
}

function createSessionRaw(user: UserRow, kp: KpRow, bank: BankRow[]): SessionRow {
  const session: SessionRow = {
    id: uid('s'), user_id: user.id, kind: 'kp', course_id: kp.course_id, title: `${kp.title} · 小测`, status: 'active',
    created_at: nowIso(), started_at: nowIso(), finished_at: null, time_limit_min: null, position: 0, task_id: null, job_id: null, result: null,
  };
  db.sessions.push(session);
  const now = Date.now();
  bank.forEach((b, index) => db.items.push({
    id: uid('qi'), session_id: session.id, bank_id: b.id, index, version: 1, status: 'ready', check: 'passed', check_note: null,
    replaced: false, hints: [], peeked: false, attempt: null, ready_at: now, check_at: now,
  }));
  return session;
}

export { kpBrief, text };
