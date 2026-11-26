// 演示用户：访客和新号码只有示例课程；演示账号（13800000000）有三门课和两周的学习记录。
import type * as T from '../api/types';
import { PLUGINS, PRESETS } from './catalog';
import { CONTENT } from './content';
import { bankForKp, instantiateCourse, kpStates, readiness } from './course';
import { addDays, db, nowIso, today, uid, type CourseRow, type UserRow } from './db';
import { planUser } from './plan';

export const DEMO_PHONE = '13800000000';

function baseUser(kind: 'guest' | 'new' | 'demo', phone: string | null, device: T.DeviceInfo): UserRow {
  return {
    id: uid('u'), nickname: kind === 'guest' ? '访客' : kind === 'demo' ? '林同学' : `同学${phone?.slice(-4) ?? ''}`,
    avatar_url: null, phone_masked: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : null, guest: kind === 'guest',
    school: kind === 'demo' ? '示例大学' : null, major: kind === 'demo' ? '计算机科学与技术' : null, timezone: device.timezone,
    onboarding: kind === 'new' ? { ai: null, course: null } : kind === 'demo' ? { ai: 'done', course: 'done' } : { ai: 'skipped', course: 'skipped' },
    deletion_at: null, created_at: nowIso(kind === 'demo' ? -14 * 86_400_000 : 0),
    phone, demo: kind === 'demo',
    settings: { daily_minutes: 120, intensity: 'standard', theme: 'system', reduce_motion: 'system', briefing: true, proactive_hints: true, memory: true },
    reminders: { daily: { enabled: true, time: '20:00' }, exam_soon: true, jobs: true },
    limits: { confirm_tokens: 20_000, daily_tokens: null },
    models: { roles: { chat: null, organize: null, generate: null, vision: null }, ocr: 'builtin', speech: 'disabled' },
    today_minutes: null, resume: null, planned_on: null, notice: null,
  };
}

export function createUser(kind: 'guest' | 'new' | 'demo', phone: string | null, device: T.DeviceInfo): UserRow {
  const user = baseUser(kind, phone, device);
  db.users.push(user);
  db.threads.push({ id: uid('th'), user_id: user.id, course_id: null, title: '全局', kind: 'global', model: null, updated_at: nowIso(), preview: null });
  for (const p of PLUGINS) {
    db.plugins.push({ user_id: user.id, id: p.id, installed: p.default === 'installed', enabled: p.default === 'installed', scope: 'all', course_ids: [], granted: p.default === 'installed' });
  }
  if (kind === 'demo') seedDemo(user);
  else {
    instantiateCourse(user, CONTENT.os, { name: '操作系统', sample: true, examInDays: 12, color: 0, withFocus: true, ingest: true });
  }
  planUser(user, true);
  return user;
}

// —— 演示账号 ——
function seedDemo(user: UserRow) {
  const deepseek = PRESETS.find((p) => p.id === 'deepseek')!;
  const conn = {
    id: uid('pv'), user_id: user.id, key: 'sk-demo-0000000000007f3a', preset_id: deepseek.id, name: deepseek.name, protocol: deepseek.protocol,
    base_url: deepseek.base_url, key_last4: '7f3a', status: 'ok' as const, status_message: null, checked_at: nowIso(-3 * 86_400_000),
    capabilities: { chat: true, json: true, tools: true, vision: false, stream: true, context_k: 128 }, models: deepseek.models.map((m) => m.id),
  };
  db.providers.push(conn);
  const bind = { connection_id: conn.id, model: deepseek.default_model };
  user.models.roles = { chat: bind, organize: bind, generate: bind, vision: null };

  const math = instantiateCourse(user, CONTENT.math, { examInDays: 3, sample: false, color: 1, withFocus: true, ingest: true });
  const os = instantiateCourse(user, CONTENT.os, { examInDays: 6, sample: false, color: 0, withFocus: true, ingest: true });
  const ds = instantiateCourse(user, CONTENT.ds, { examInDays: 13, sample: false, color: 3, withFocus: true, ingest: true });

  history(user, math, { mastered: 0.55, shaky: 0.15, learned: 0.12, due: 2 });
  history(user, os, { mastered: 0.32, shaky: 0.14, learned: 0.1, due: 3 });
  history(user, ds, { mastered: 0.14, shaky: 0.1, learned: 0.08, due: 0 });

  const yesterday = addDays(today(), -1);
  // 昨天没做完、今天顺延的学习任务：挑一个还没学、老师没说不考的知识点，重点优先
  const osStates = kpStates(os.id);
  const osKps = db.kps.filter((k) => k.course_id === os.id && k.level !== 'excluded' && !k.understood_at && osStates.get(k.id) === 'new');
  const bank = osKps.find((k) => k.level === 'emphasized') ?? osKps.find((k) => k.level === 'mentioned') ?? osKps[0]!;
  db.tasks.push(
    { id: uid('t'), user_id: user.id, course_id: os.id, date: yesterday, kind: 'learn', title: bank.title, minutes: 20, status: 'todo', reason: '老师强调 · 还没学', moved_from: null, pinned: false, kp_ids: [bank.id], session_id: null, progress: null },
    { id: uid('t'), user_id: user.id, course_id: math.id, date: yesterday, kind: 'practice', title: '快练 5 道', minutes: 10, status: 'todo', reason: '有 4 个知识点不稳', moved_from: null, pinned: false, kp_ids: [], session_id: null, progress: null },
    { id: uid('t'), user_id: user.id, course_id: math.id, date: yesterday, kind: 'learn', title: '洛必达法则', minutes: 25, status: 'done', reason: '课件内容 · 还没学', moved_from: null, pinned: false, kp_ids: [], session_id: null, progress: null },
  );
  user.resume = { kind: 'kp', course_id: os.id, title: bank.title, detail: '讲解看到一半', href: `/c/${os.id}/kp/${bank.id}`, updated_at: nowIso(-2 * 3_600_000), device: '华为 MatePad' };

  db.notifications.push(
    { id: uid('n'), user_id: user.id, kind: 'exam_soon', title: '高等数学还有 3 天考试', body: '今天的任务已经按它优先排好了', href: `/c/${math.id}`, created_at: nowIso(-3_600_000), read: false },
    { id: uid('n'), user_id: user.id, kind: 'job_done', title: '数据结构的资料整理完了', body: '整理出 39 个知识点', href: `/c/${ds.id}`, created_at: nowIso(-26 * 3_600_000), read: true },
  );
  db.memory.push(
    { id: uid('mem'), user_id: user.id, text: '晚上学习效率高', source: 'user', created_at: nowIso(-5 * 86_400_000) },
    { id: uid('mem'), user_id: user.id, text: '讲解要短，先看例子', source: 'user', created_at: nowIso(-4 * 86_400_000) },
    { id: uid('mem'), user_id: user.id, text: '条件判断类的选择题容易错', source: 'practice', created_at: nowIso(-2 * 86_400_000) },
  );
  const features: T.Feature[] = ['organize', 'generate', 'verify', 'chat'];
  for (let d = 13; d >= 0; d -= 1) {
    for (const [i, c] of [math, os, ds].entries()) {
      if ((d + i) % 3 === 0) continue;
      const feature = features[(d + i) % features.length]!;
      const tokens = 4_000 + ((d * 37 + i * 911) % 9) * 1_300;
      db.usage.push({
        id: uid('us'), user_id: user.id, course_id: c.id, feature, plugin_id: feature === 'generate' && i === 0 ? 'compute-first' : null,
        label: { organize: '整理资料', generate: '出题', verify: '核对题目', chat: '对话', vision: '看图', plugin: '插件' }[feature],
        tokens_in: Math.round(tokens * 0.7), tokens_out: Math.round(tokens * 0.3), cost: +(tokens * 3.2e-6).toFixed(3),
        created_at: `${addDays(today(), -d)}T2${i}:1${d % 6}:00${nowIso().slice(19)}`,
      });
    }
  }
  db.devices.push(
    { id: uid('dv'), user_id: user.id, kind: 'tablet', name: '华为 MatePad', last_seen: nowIso(-2 * 3_600_000) },
    { id: uid('dv'), user_id: user.id, kind: 'phone', name: '华为 Mate 手机', last_seen: nowIso(-20 * 3_600_000) },
  );
  const osThread = db.threads.find((t) => t.course_id === os.id)!;
  const userMsg = uid('msg');
  db.messages.push(
    { id: userMsg, thread_id: osThread.id, role: 'user', text: '页面置换的三种算法有什么区别？', created_at: nowIso(-30 * 3_600_000), tools: [], refs: [], cards: [], memory: [], status: 'done', error: null },
    {
      id: uid('msg'), thread_id: osThread.id, role: 'assistant', created_at: nowIso(-30 * 3_600_000 + 4000), memory: [], status: 'done', error: null,
      text: '区别在于缺页时换出哪一页：FIFO 换出最早进来的，LRU 换出最久没用的，OPT 换出以后最久不用的。OPT 缺页最少但做不到，只作比较基准。',
      tools: [{ label: '查了课件第 24、25 页' }], refs: [], cards: [],
    },
  );
  osThread.updated_at = nowIso(-30 * 3_600_000 + 4000);
  osThread.preview = '区别在于缺页时换出哪一页……';
}

interface Mix { mastered: number; shaky: number; learned: number; due: number }

/** 生成过去两周的练习记录，让掌握度、错题、学情、历史都有内容 */
function history(user: UserRow, course: CourseRow, mix: Mix) {
  // 按课件顺序学：前面的章节掌握得多，重点不一定都已掌握（准备度才像真实情况）
  const kps = db.kps.filter((k) => k.course_id === course.id && k.level !== 'excluded').sort((a, b) => a.order - b.order);
  const n = kps.length;
  const take = (ratio: number) => Math.round(n * ratio);
  const mastered = kps.slice(0, take(mix.mastered));
  const shaky = kps.slice(take(mix.mastered), take(mix.mastered) + take(mix.shaky));
  const learned = kps.slice(take(mix.mastered) + take(mix.shaky), take(mix.mastered) + take(mix.shaky) + take(mix.learned));
  const days = [12, 9, 6, 4, 2, 1];
  const sessions = days.map((d) => ({ d, picks: [] as { bank: string; outcome: 'correct' | 'wrong' | 'partial' }[] }));
  mastered.forEach((kp, i) => {
    const bank = bankForKp(kp.id);
    const [a, b] = [bank[0], bank[1] ?? bank[0]];
    sessions[i % 3]!.picks.push({ bank: a!.id, outcome: 'correct' });
    sessions[3 + (i % 3)]!.picks.push({ bank: b!.id, outcome: 'correct' });
    kp.understood_at = nowIso(-(13 - (i % 5)) * 86_400_000);
  });
  shaky.forEach((kp, i) => {
    const bank = bankForKp(kp.id)[0]!;
    sessions[2 + (i % 4)]!.picks.push({ bank: bank.id, outcome: i % 3 === 0 ? 'partial' : 'wrong' });
  });
  for (const kp of learned) kp.understood_at = nowIso(-3 * 86_400_000);
  const ratioAt: { date: string; ratio: number }[] = [];
  for (const { d, picks } of sessions) {
    if (!picks.length) continue;
    const when = (offset: number) => `${addDays(today(), -d)}T${String(19 + (offset % 3)).padStart(2, '0')}:${String(10 + offset * 3).padStart(2, '0')}:00${nowIso().slice(19)}`;
    const s = {
      id: uid('s'), user_id: user.id, kind: (d === 2 ? 'mock' : d % 2 ? 'quick' : 'kp') as T.SessionKind, course_id: course.id,
      title: `${course.name} · ${d === 2 ? '模拟卷' : d % 2 ? '快练' : '按知识点练'}`, status: 'finished' as T.SessionStatus,
      created_at: when(0), started_at: when(0), finished_at: when(6), time_limit_min: d === 2 ? 120 : null, position: 0, task_id: null, job_id: null,
      result: null as T.Result | null,
    };
    db.sessions.push(s);
    let score = 0;
    let total = 0;
    picks.forEach((p, index) => {
      const b = db.bank.find((x) => x.id === p.bank)!;
      const value = p.outcome === 'correct' ? b.score : p.outcome === 'partial' ? Math.round(b.score / 2) : 0;
      score += value;
      total += b.score;
      const item = {
        id: uid('qi'), session_id: s.id, bank_id: b.id, index, version: 1, status: 'ready' as const, check: 'passed' as const, check_note: null,
        replaced: false, hints: [], peeked: false, ready_at: 0, check_at: 0,
        attempt: { response: b.type === 'single' ? (p.outcome === 'correct' ? b.key : 'A') : '（作答）', state: 'graded' as const, correct: p.outcome === 'correct', score: value, marks: null, answered_at: when(1 + index) },
      };
      db.items.push(item);
      db.events.push({ id: uid('ev'), user_id: user.id, kp_id: b.kp_id, bank_id: b.id, item_id: item.id, session_id: s.id, outcome: p.outcome, counted: true, hinted: false, at: when(1 + index) });
      if (p.outcome !== 'correct') {
        db.mistakes.push({ user_id: user.id, bank_id: b.id, course_id: course.id, wrong_count: 1, correct_streak: 0, last_wrong_at: when(1 + index), reason: p.outcome === 'partial' ? '自评：部分得分' : b.type === 'single' ? '选了 A' : '自评：没有得分', streak_sessions: [], removed: false });
      }
    });
    s.result = {
      session: null as unknown as T.Session, score, total, accuracy: picks.filter((p) => p.outcome === 'correct').length / picks.length,
      duration_sec: picks.length * 95, mastery: [], chapters: [], mistakes: [], review: null, task: null,
    };
    const r = readiness(course.id);
    ratioAt.push({ date: addDays(today(), -d), ratio: r.total ? r.mastered / r.total : 0 });
  }
  for (const kp of mastered.slice(0, mix.due)) { kp.stability = 2.5; kp.due = today(); }
  for (const kp of mastered.slice(mix.due)) { kp.stability = 6; kp.due = addDays(today(), 3); }
  for (const kp of shaky) { kp.stability = 0.5; kp.due = addDays(today(), 1); }
  const now = readiness(course.id);
  ratioAt.push({ date: today(), ratio: now.total ? now.mastered / now.total : 0 });
  for (const row of ratioAt) {
    const existing = db.readiness.find((x) => x.course_id === course.id && x.date === row.date);
    if (existing) existing.ratio = row.ratio;
    else db.readiness.push({ course_id: course.id, ...row });
  }
}
