// 演示助手：按关键词识别意图，调用和页面相同的操作，结果以流式文字 + 卡片返回（03、09 第 9 节）。
// 真实服务端由模型做意图识别和讲解；这里只模拟形状和节奏。
import type * as T from '../api/types';
import { changed } from './bus';
import { wait } from './config';
import { L, T as text } from './content';
import { addFocus, bankForKp, chapterView, explainFor, kpStates, readiness, refView } from './course';
import { addDays, byId, daysBetween, db, nowIso, today, uid, type CourseRow, type KpRow, type MessageRow, type ThreadRow, type UserRow } from './db';
import { planUser, replanTracked } from './plan';
import { hasAi, hint as giveHint, kpQuizSession, questionView } from './practice';
import { withUndo } from './undo';

const NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
const DAY_WORD: Record<string, number> = { 明天: 1, 后天: 2, 周末: 0 };

function parseNumber(s: string) {
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === '一个半') return 1.5;
  return NUM[s] ?? null;
}

function courseInText(user: UserRow, value: string, fallback: CourseRow | null) {
  const mine = db.courses.filter((c) => c.user_id === user.id);
  return mine.find((c) => value.includes(c.name) || value.includes(c.name.slice(0, 2))) ?? fallback;
}

function kpInText(courseIds: T.ID[], value: string): KpRow | undefined {
  const norm = (s: string) => s.replace(/[\s\-·、，。？?]/g, '').toLowerCase();
  const v = norm(value);
  const kps = db.kps.filter((k) => courseIds.includes(k.course_id));
  return kps.find((k) => v.includes(norm(k.title)))
    ?? kps.find((k) => norm(k.title).length >= 3 && v.includes(norm(k.title).slice(0, 4)))
    ?? kps.find((k) => /[A-Za-z]{2,}/.test(k.title) && (k.title.match(/[A-Za-z]{2,}/g) ?? []).some((w) => v.includes(w.toLowerCase())));
}

interface Turn { user: UserRow; thread: ThreadRow; textIn: string; context: T.ChatContext; command?: T.Command }

export async function* respond(turn: Turn): AsyncGenerator<T.ChatEvent> {
  const { user, thread, textIn, context, command } = turn;
  const userMsg: MessageRow = { id: uid('msg'), thread_id: thread.id, role: 'user', text: textIn, created_at: nowIso(), tools: [], refs: [], cards: [], memory: [], status: 'done', error: null };
  const reply: MessageRow = { id: uid('msg'), thread_id: thread.id, role: 'assistant', text: '', created_at: nowIso(), tools: [], refs: [], cards: [], memory: [], status: 'done', error: null };
  db.messages.push(userMsg, reply);
  thread.updated_at = nowIso();
  yield { type: 'start', message_id: reply.id, user_message_id: userMsg.id };

  const course = context.course_id ? byId('courses', context.course_id) ?? null : thread.course_id ? byId('courses', thread.course_id) ?? null : null;
  const sampleOnly = db.courses.filter((c) => c.user_id === user.id).every((c) => c.sample);
  if (!hasAi(user) && !(course?.sample || sampleOnly)) {
    const card: T.Card = { id: uid('card'), created_at: nowIso(), kind: 'connect', reason: '连接 AI 模型后，助手就能回答和操作' };
    reply.cards.push(card);
    reply.text = '还没有连接 AI 模型。';
    yield { type: 'text', delta: reply.text };
    yield { type: 'card', card };
    yield { type: 'done' };
    return;
  }

  const say = async function* (value: string) {
    for (let i = 0; i < value.length; i += 6) {
      const delta = value.slice(i, i + 6);
      reply.text += delta;
      yield { type: 'text' as const, delta };
      await wait(28);
    }
  };
  const tool = async function* (label: string) {
    const id = uid('tool');
    yield { type: 'tool' as const, id, label, status: 'running' as const };
    await wait(420);
    reply.tools.push({ label });
    yield { type: 'tool' as const, id, label, status: 'done' as const };
  };
  const card = function (c: T.Card) {
    reply.cards.push(c);
    return { type: 'card' as const, card: c };
  };
  const base = () => ({ id: uid('card'), created_at: nowIso() });
  const scope = course ? [course.id] : db.courses.filter((c) => c.user_id === user.id).map((c) => c.id);
  const kpCtx = context.kp_id ? byId('kps', context.kp_id) : undefined;
  const value = textIn.trim();

  // —— 知识点页上的 AI 动作 ——
  if (command && kpCtx) {
    const sections = explainFor(kpCtx);
    if (command === 'simplify') {
      yield* tool(`读了“${kpCtx.title}”的讲解`);
      const plain = kpCtx.summary.split(/[，；]/u);
      yield card({ ...base(), kind: 'explain', title: `${kpCtx.title} · 简单说`, kp_id: kpCtx.id, blocks: [text(`一句话：**${plain[0]}**。`), text(plain.slice(1).join('，') ? `展开一点：${plain.slice(1).join('，')}` : '记住这一句，就抓住了它的核心。')], refs: kpCtx.refs.map((r) => refView(r)) });
    } else if (command === 'example') {
      yield* tool('查了相关例题');
      const q = bankForKp(kpCtx.id).find((b) => b.authored) ?? bankForKp(kpCtx.id)[0];
      const blocks: T.Block[] = q ? [text('**例题**'), ...q.stem, text('**解**'), ...q.steps.flat()] : [text(sections[0]?.map((b) => (b.kind === 'text' ? b.text : '')).join('') ?? kpCtx.summary)];
      yield card({ ...base(), kind: 'explain', title: `${kpCtx.title} · 例子`, kp_id: kpCtx.id, blocks, refs: kpCtx.refs.map((r) => refView(r)) });
    } else if (command === 'quiz') {
      yield* tool('出了 1 道题');
      const session = kpQuizSession(user, kpCtx);
      const item = db.items.find((i) => i.session_id === session.id && !i.attempt) ?? db.items.find((i) => i.session_id === session.id);
      if (item) yield card({ ...base(), kind: 'question', question: questionView(item) });
    } else if (command === 'compare') {
      const other = db.kps.find((k) => k.topic_id === kpCtx.topic_id && k.order === kpCtx.order + 1) ?? db.kps.find((k) => k.topic_id === kpCtx.topic_id && k.id !== kpCtx.id);
      yield* tool(`对比了“${kpCtx.title}”和“${other?.title ?? ''}”`);
      if (other) yield card({ ...base(), kind: 'explain', title: `${kpCtx.title} 和 ${other.title}`, kp_id: kpCtx.id, blocks: [{ kind: 'table', header: ['', kpCtx.title, other.title], rows: [['是什么', kpCtx.summary.split(/[，；]/u)[0] ?? '', other.summary.split(/[，；]/u)[0] ?? ''], ['要点', kpCtx.summary.split(/[，；]/u).slice(1).join('，') || '—', other.summary.split(/[，；]/u).slice(1).join('，') || '—']] }], refs: [...kpCtx.refs, ...other.refs].map((r) => refView(r)) });
    }
    yield { type: 'done' };
    return;
  }

  // —— 做题时 ——
  const item = context.question_id ? byId('items', context.question_id) : undefined;
  if (item && !item.attempt) {
    if (/答案|直接告诉/.test(value)) {
      const { question } = giveHint(user, item.id, 3);
      yield* say('完整解析在下面。这道题会记为“看过答案”，答对也不计入掌握。');
      if (question.solution) yield card({ ...base(), kind: 'explain', title: '完整解析', kp_id: question.kp.id, blocks: question.solution.steps.flatMap((s) => s.blocks), refs: question.refs });
    } else {
      const level = Math.min(2, item.hints.length + 1) as 1 | 2;
      const { hint } = giveHint(user, item.id, level);
      yield* tool(level === 1 ? '查了相关的课件页' : '看了解题需要的条件');
      yield* say(hint.text);
      if (hint.refs.length) { reply.refs.push(...hint.refs); yield { type: 'refs', refs: hint.refs }; }
    }
    changed(user.id, ['session']);
    yield { type: 'done' };
    return;
  }

  // —— 今天的时间 ——
  const hours = value.match(/今天只有\s*(\d+(?:\.\d+)?|一个半|一|两|半|三|四)\s*个?\s*(小时|钟头|h|分钟|min)/i);
  if (hours) {
    const n = parseNumber(hours[1]!) ?? 1;
    const minutes = Math.round(/分钟|min/i.test(hours[2]!) ? n : n * 60);
    const before = user.today_minutes?.date === today() ? user.today_minutes.minutes : user.settings.daily_minutes;
    yield* tool('重排了今天的任务');
    const undo = withUndo(user, '已调整今天的时间', `今天可用时间改回 ${before} 分钟`, ['today', 'schedule'], (t) => {
      t.before('users', user);
      user.today_minutes = { date: today(), minutes };
      replanTracked(user, t);
    });
    const todays = db.tasks.filter((x) => x.user_id === user.id && x.date === today() && x.status === 'todo');
    yield* say(`好，今天按 ${minutes} 分钟排：${todays.slice(0, 3).map((x) => x.title).join('、')}${todays.length > 3 ? ' 等' : ''}。`);
    yield card({ ...base(), kind: 'change', title: '调整了今天的时间', changes: [{ label: '今天可用时间', from: `${before} 分钟`, to: `${minutes} 分钟` }, { label: '今天的任务', from: '', to: `${todays.length} 项` }], affects: ['today', 'schedule'], undo_id: undo.id, state: 'applied', href: '/' });
    changed(user.id, ['today', 'schedule']);
    yield { type: 'done' };
    return;
  }

  // —— 挪动某门课的任务 ——
  const move = value.match(/(挪|推|移|放)到(明天|后天|周末)/);
  if (move) {
    const target = courseInText(user, value, course);
    const d0 = today();
    let date = addDays(d0, DAY_WORD[move[2]!] || 1);
    if (move[2] === '周末') { const dow = new Date().getDay(); date = addDays(d0, dow === 6 ? 7 : 6 - dow); }
    const tasks = db.tasks.filter((x) => x.user_id === user.id && x.date === d0 && x.status === 'todo' && (!target || x.course_id === target.id));
    if (!tasks.length) {
      yield* say(target ? `${target.name}今天没有要挪的任务。` : '今天没有要挪的任务。');
      yield { type: 'done' };
      return;
    }
    yield* tool(`挪动了${target?.name ?? ''}今天的 ${tasks.length} 项任务`);
    const label = move[2] === '周末' ? '周末' : move[2]!;
    const undo = withUndo(user, `已挪到${label}`, '任务挪回今天', ['today', 'schedule'], (t) => {
      for (const task of tasks) { t.before('tasks', task); task.date = date; task.pinned = true; }
    });
    yield* say(`已把${target?.name ?? ''}今天的 ${tasks.length} 项挪到${label}，固定在那天，不会被自动重排。`);
    yield card({ ...base(), kind: 'change', title: `${target?.name ?? '任务'}挪到${label}`, changes: tasks.map((x) => ({ label: x.title, from: '今天', to: label })), affects: ['today', 'schedule'], undo_id: undo.id, state: 'applied', href: '/schedule' });
    changed(user.id, ['today', 'schedule']);
    yield { type: 'done' };
    return;
  }

  // —— 老师说的重点 ——
  if (/老师(说|讲|划)|划重点|重点是/.test(value) && course) {
    const words = value.replace(/^.*?(老师(说|讲|划)(了)?(的)?(重点)?[:：，,]?|划重点[:：，,]?|重点是[:：]?)/u, '').trim() || value;
    yield* tool('记录老师的原话并对应到知识点');
    let fragments: ReturnType<typeof addFocus> = [];
    const undo = withUndo(user, '已记下老师说的重点', '删掉刚记的原话', ['focus', 'map', 'today'], (t) => {
      for (const kp of db.kps.filter((k) => k.course_id === course.id)) t.before('kps', kp);
      fragments = addFocus(course, words, true);
      for (const f of fragments) t.added('fragments', f);
    });
    const rows = fragments.map((f) => ({ label: f.text, from: '', to: f.found ? `${f.kps.filter((k) => k.certainty === 'sure').length} 个知识点 · ${f.kps[0]?.level === 'excluded' ? '不考' : f.kps[0]?.level === 'emphasized' ? '强调' : '提及'}` : '课件里没找到' }));
    yield* say(`记下了 ${fragments.length} 句，已经对应到知识点，地图上的标记跟着更新了。`);
    yield card({ ...base(), kind: 'change', title: '记录老师重点', changes: rows, affects: ['focus', 'map', 'today'], undo_id: undo.id, state: 'applied', href: `/c/${course.id}/focus` });
    planUser(user, true);
    changed(user.id, ['focus', 'map', 'course', 'today', 'schedule'], course.id);
    yield { type: 'done' };
    return;
  }

  // —— 出题 ——
  const practice = value.match(/(?:出|来|做|练)\s*(\d+|[一两二三四五六七八九十])\s*道/);
  if (practice || /考考我|练一练|刷题/.test(value)) {
    const target = courseInText(user, value, course) ?? db.courses.find((c) => c.user_id === user.id);
    const kp = kpInText(target ? [target.id] : scope, value);
    const count = practice ? parseNumber(practice[1]!) ?? 5 : 5;
    if (target) {
      yield* tool(kp ? `找到了“${kp.title}”的题` : `从${target.name}挑了薄弱和到期的题`);
      yield* say(kp ? `准备好了 ${count} 道“${kp.title}”的题。` : `准备好了一组${target.name}快练，按薄弱和到期挑。`);
      yield card({ ...base(), kind: 'practice', title: kp ? `${kp.title} · ${count} 道` : `${target.name} · 快练 ${count} 道`, session_kind: kp ? 'kp' : 'quick', course_id: target.id, kp_id: kp?.id ?? null, count, minutes: count * 2, session_id: null });
    }
    yield { type: 'done' };
    return;
  }

  // —— 来得及吗 ——
  if (/来得及|来不及|赶得上|怎么办|还差多少/.test(value)) {
    const courses = course ? [course] : db.courses.filter((c) => c.user_id === user.id && c.exam_date);
    yield* tool('看了各门课的掌握度和日程');
    const lines = courses.map((c) => {
      const r = readiness(c.id);
      const left = c.exam_date ? daysBetween(today(), c.exam_date) : null;
      return `${c.name}：重点掌握 ${r.mastered}/${r.total}${left !== null ? `，还有 ${left} 天` : ''}`;
    });
    const urgent = courses.filter((c) => c.exam_date).sort((a, b) => (a.exam_date! < b.exam_date! ? -1 : 1))[0];
    yield* say(`${lines.join('；')}。${urgent ? `先保住${urgent.name}：今天把它的任务做完，比平均用力更有效。` : ''}`);
    planUser(user);
    const days = [0, 1, 2].map((i) => addDays(today(), i)).map((date) => ({ date, tasks: db.tasks.filter((x) => x.user_id === user.id && x.date === date && x.status !== 'skipped').map(({ user_id: _u, ...rest }) => rest) }));
    yield card({ ...base(), kind: 'schedule', title: '接下来三天', days });
    yield { type: 'done' };
    return;
  }

  // —— 考试形式（先提议）——
  if (/考试形式|题型|题量|开卷|闭卷/.test(value) && course) {
    const match = value.match(/(单选|填空|计算|简答|证明|设计)[题]?\s*(?:改成|改为|变成)?\s*(\d+)\s*道/);
    const types: Record<string, T.QuestionType> = { 单选: 'single', 填空: 'fill', 计算: 'calc', 简答: 'short', 证明: 'proof', 设计: 'design' };
    const changes: T.ChangeRow[] = [];
    if (match) {
      const type = types[match[1]!]!;
      const before = course.format.types.find((x) => x.type === type)?.count ?? 0;
      changes.push({ label: `${match[1]}题`, from: `${before} 道`, to: `${match[2]} 道` });
    } else if (/开卷|闭卷/.test(value)) {
      changes.push({ label: '开闭卷', from: course.format.open_book ? '开卷' : '闭卷', to: /开卷/.test(value) ? '开卷' : '闭卷' });
    }
    if (changes.length) {
      yield* say('考试形式会影响模拟卷和计划，确认后再改：');
      yield card({ ...base(), kind: 'proposal', title: '修改考试形式', changes, estimate: null, affects: ['focus', 'practice'], state: 'pending' });
    } else {
      yield* say(`现在的考试形式：${course.format.types.filter((x) => x.count).map((x) => `${({ single: '单选', fill: '填空', calc: '计算', short: '简答', proof: '证明', design: '设计' })[x.type]} ${x.count} 道`).join('、')}，${course.format.duration_min ?? '?'} 分钟。要改哪一项？`);
    }
    yield { type: 'done' };
    return;
  }

  // —— 删除资料（先提议）——
  if (/(删除|删掉|移除).*(资料|课件|文件)/.test(value) && course) {
    const m = db.materials.filter((x) => x.course_id === course.id).find((x) => value.includes(x.title.replace(/\.\w+$/, '').slice(0, 4))) ?? db.materials.filter((x) => x.course_id === course.id).at(-1);
    if (m) {
      yield* say('删除资料不能撤销，确认后才会执行：');
      yield card({ ...base(), kind: 'proposal', title: `删除《${m.title}》`, changes: [{ label: '资料', from: m.title, to: '删除' }, { label: '同时删掉', from: '', to: `${m.kp_count ?? 0} 个知识点、${m.question_count} 道题` }], estimate: null, affects: ['materials', 'map', 'course'], state: 'pending' });
    }
    yield { type: 'done' };
    return;
  }

  // —— 用量 ——
  if (/用量|花了多少|token|费用/.test(value)) {
    const week = db.usage.filter((u) => u.user_id === user.id && u.created_at.slice(0, 10) >= addDays(today(), -6));
    const tokens = week.reduce((s, u) => s + u.tokens_in + u.tokens_out, 0);
    const cost = week.reduce((s, u) => s + (u.cost ?? 0), 0);
    yield card({ ...base(), kind: 'usage', label: '最近 7 天', tokens, cost: +cost.toFixed(2) });
    yield { type: 'done' };
    return;
  }

  // —— 记住偏好 ——
  if (/记住|我(晚上|早上|中午).{0,6}(效率|学得)|我喜欢|讲解要/.test(value) && user.settings.memory) {
    const item = { id: uid('mem'), user_id: user.id, text: value.replace(/^(请)?记住[:：，,]?/u, '').slice(0, 40), source: 'user' as const, created_at: nowIso() };
    db.memory.push(item);
    const { user_id: _u, ...view } = item;
    reply.memory.push(view);
    yield* say('好的。');
    yield { type: 'memory', item: view };
    yield { type: 'done' };
    return;
  }

  // —— 讲解 ——
  const kp = kpInText(scope, value) ?? (/(这个|这一点|它)/.test(value) ? kpCtx : undefined);
  if (kp) {
    const refs = kp.refs.map((r) => refView(r));
    yield* tool(`查课件：${kp.title}`);
    const states = kpStates(kp.course_id);
    yield* say(`${kp.summary}${states.get(kp.id) === 'shaky' ? ' 这个点你之前做错过，建议讲完马上做两道题。' : ''}`);
    reply.refs.push(...refs);
    yield { type: 'refs', refs };
    yield card({ ...base(), kind: 'explain', title: kp.title, kp_id: kp.id, blocks: explainFor(kp).flat(), refs });
    yield { type: 'done' };
    return;
  }

  // —— 地图 / 进度 ——
  if (/地图|进度|掌握/.test(value) && course) {
    const states = kpStates(course.id);
    const chapter = db.chapters.filter((c) => c.course_id === course.id).sort((a, b) => a.order - b.order)[0];
    if (chapter) yield card({ ...base(), kind: 'map', course_id: course.id, chapter: chapterView(chapter.id, states) });
    yield { type: 'done' };
    return;
  }

  // —— 兜底 ——
  yield* say(course ? `课件里没找到相关内容。可以试试：` : '可以这样问我：');
  yield card({
    ...base(), kind: 'explain', title: '可以这样说', kp_id: null,
    blocks: [L(course ? [`讲讲${db.kps.find((k) => k.course_id === course.id && k.level === 'emphasized')?.title ?? '一个知识点'}`, '来 5 道题', '今天只有 1 小时', '把这门课挪到明天', '老师说……（粘贴原话）'] : ['我是不是来不及了', '今天只有 1 小时', '来 5 道题', '把操作系统挪到明天'], false)],
    refs: [],
  });
  yield { type: 'done' };
}
