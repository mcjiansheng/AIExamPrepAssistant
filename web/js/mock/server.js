// 演示后端：在浏览器里按 docs/接口合同/api-v0.md 实现全部接口，状态存在 localStorage。
// 用途：后端没写好时前端能完整走通；也是每个接口的可运行样例。
// 它不是产品逻辑的参考实现：计划、判分、掌握度这里只做了够演示的简化版，真实规则见 docs/设计/设计修订v2.md。

import { OS_CHAPTERS, FOCUS_KEYWORDS, EXCLUDE_WORDS, EMPH_WORDS, SEED_FOCUS_TEXT, DEFAULT_FORMAT, QUESTION_POOL } from './data.js';

const KEY = 'examprep-mock-v1';
const MULT = { excluded: 0, none: 1, mentioned: 2.5, emphasized: 4, conflict: 4 };
const MASTERY_COEF = { new: 1, shaky: 1.2, mastered: 0.3 };

let S = null;   // 在文件末尾初始化（依赖下面定义的函数）

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 存储不可用时退回内存 */ }
  return seed();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* 忽略 */ } }
export function resetMock() { S = seed(); save(); }

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const notFound = (what) => new HttpError(404, 'not_found', `${what}不存在`);

const now = () => Date.now();
const iso = (ms = now()) => new Date(ms).toISOString();
const id = (p) => `${p}_${(S.seq++).toString(36)}`;
const clone = (x) => (x === undefined ? null : JSON.parse(JSON.stringify(x)));
function dateISO(offsetDays = 0, from) {
  const d = from ? new Date(from + 'T00:00:00') : new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);

/* ======================= 初始数据 ======================= */

function buildStructure(course) {
  course.chapters = clone(OS_CHAPTERS);
  course.kps = {};
  let n = 0;
  for (const ch of course.chapters) {
    for (const t of ch.topics) {
      t.kp_ids = t.kps.map((title) => {
        const kid = `${course.id}_kp${++n}`;
        course.kps[kid] = { id: kid, title, topic_id: t.id, mastery: 'new', correct: 0 };
        return kid;
      });
      delete t.kps;
    }
  }
}

function seed() {
  S = { seq: 1, courses: {}, order: [], materials: {}, suggestions: {}, jobs: {}, exams: {}, chats: {}, chatActions: {}, proposals: {} };
  const os = { id: 'c_os', name: '操作系统', exam_date: dateISO(12), created_at: iso(), format: clone(DEFAULT_FORMAT), focus: { text: '', analyzed_at: null, job_id: null, fragments: [], choices: {}, resolved: {} }, plan: null, exams: [] };
  S.courses.c_os = os; S.order.push('c_os');
  buildStructure(os);

  const mats = [
    ['m1', '第二章 进程管理.pdf', 'slides', 86, 28, 'done'],
    ['m2', '第三章 存储管理 2026.pdf', 'slides', 64, 19, 'done'],
    ['m3', '第三章 存储管理.pptx', 'slides', 66, 20, 'done'],
    ['m4', '第四章 设备管理.pptx', 'slides', 146, 31, 'partial'],
    ['m5', '作业1-进程调度.docx', 'homework', 6, 4, 'none'],
    ['m6', '期末复习提纲.pdf', 'other', 4, 9, 'done'],
  ];
  mats.forEach(([mid, title, kind, pages, kp, vision], i) => {
    S.materials[mid] = { id: mid, course_id: 'c_os', title, kind, pages, status: 'ready', stage: null, progress: null, kp_count: kp, vision, superseded_by: null, error: null, uploaded_at: iso(now() - (10 - i) * 36e5) };
  });
  S.materials.m2.superseded_by = 'm3';
  S.suggestions.s1 = { id: 's1', course_id: 'c_os', kind: 'version', title: '这两份像是同一课件的不同版本，用哪一份？', detail: '“第三章 存储管理.pptx”的内嵌修改日期更新，已暂时用它。', options: [{ id: 'm3', label: '第三章 存储管理.pptx' }, { id: 'm2', label: '第三章 存储管理 2026.pdf' }], default_option: 'm3', material_ids: ['m2', 'm3'], kp_ids: [], answered: false };
  S.suggestions.s2 = { id: 's2', course_id: 'c_os', kind: 'role', title: '“期末复习提纲.pdf”像是老师的复习材料', detail: '按老师重点处理后，里面的内容会算作强调。', options: [{ id: 'review', label: '按老师重点处理' }, { id: 'other', label: '当普通资料' }], default_option: 'other', material_ids: ['m6'], kp_ids: [], answered: false };

  // 已分析过的重点
  os.focus.text = SEED_FOCUS_TEXT;
  os.focus.fragments = analyze(os, SEED_FOCUS_TEXT);
  os.focus.analyzed_at = iso(now() - 2 * 36e5);

  // 一些掌握度
  const byTitle = (t) => Object.values(os.kps).find((k) => k.title === t);
  ['进程状态转换', '进程的概念与特征', 'FCFS 与 SJF'].forEach((t) => { byTitle(t).mastery = 'mastered'; byTitle(t).correct = 2; });
  ['时间片轮转 RR', '信号量机制', '分页地址转换'].forEach((t) => { byTitle(t).mastery = 'shaky'; });

  os.plan = { id: 'p_os', days: 4, hours_per_day: 1.5, start_date: dateISO(0), pins: {}, done: {}, stale: false };
  os.plan.done[`pi_t_proc_study`] = true;

  // 一套做完的题
  const e = createExam(os, 5, 'all', { instant: true, title: '第 1 套', offsetMs: -864e5 });
  const answers = ['D', '9', null, 'B', null];
  e.questions.forEach((q, i) => {
    if (q.type === 'calc') { doAttempt(q, '', os); doGrade(q, { [q.solution.rubric[0].id]: 'full', [q.solution.rubric[1].id]: 'partial', [q.solution.rubric[2].id]: 'full' }, os); }
    else if (q.type === 'short') { doAttempt(q, '', os); doGrade(q, Object.fromEntries(q.solution.rubric.map((r, j) => [r.id, j < 3 ? 'full' : 'none'])), os); }
    else doAttempt(q, answers[i], os);
  });
  finish(e, os);

  const ba = { id: 'c_ba', name: '商务智能', exam_date: dateISO(20), created_at: iso(), format: clone(DEFAULT_FORMAT), focus: { text: '', analyzed_at: null, job_id: null, fragments: [], choices: {}, resolved: {} }, plan: null, exams: [], chapters: [], kps: {} };
  S.courses.c_ba = ba; S.order.push('c_ba');
  return S;
}

/* ======================= 任务推进 ======================= */

function newJob(kind, target_id, durationMs, stages) {
  const j = { id: id('job'), kind, target_id, status: 'running', started: now(), duration: durationMs, stages, created_at: iso(), applied: false, error: null };
  S.jobs[j.id] = j;
  return j;
}
function jobView(j) {
  if (!j) return null;
  const p = Math.min(1, (now() - j.started) / j.duration);
  const stageIdx = Math.min(j.stages.length - 1, Math.floor(p * j.stages.length));
  return {
    id: j.id, kind: j.kind, status: j.status, target_id: j.target_id, created_at: j.created_at, error: j.error,
    progress: j.status === 'done' ? 1 : Math.round(p * 100) / 100,
    stage: j.status === 'done' ? null : j.stages[stageIdx],
  };
}

/** 每次请求前推进所有任务：到时间的任务完成并产生效果 */
function tick() {
  const t = now();
  for (const j of Object.values(S.jobs)) {
    if (j.status !== 'running') continue;
    const p = Math.min(1, (t - j.started) / j.duration);
    if (j.kind === 'ingest') {
      for (const mid of j.material_ids) {
        const m = S.materials[mid];
        if (!m || m.status === 'failed') continue;
        if (m._broken && p >= 0.2) {
          Object.assign(m, { status: 'failed', stage: null, progress: null, pages: null, error: { message: '文件已损坏或不是有效的文档，换一份再上传', retryable: false } });
          continue;
        }
        m.progress = Math.round(p * 100) / 100;
        m.status = p < 0.2 ? 'reading' : 'extracting';
        m.stage = p < 0.2 ? '读取文字' : '整理知识点';
      }
    }
    if (j.kind === 'exam') advanceExam(S.exams[j.target_id], t);
    if (p >= 1) { j.status = 'done'; complete(j); }
  }
  for (const m of Object.values(S.materials)) {
    if (m.vision === 'partial' && m.vision_done_at && t > m.vision_done_at) m.vision = 'done';
  }
}

function complete(j) {
  if (j.applied) return;
  j.applied = true;
  if (j.kind === 'ingest') {
    const course = S.courses[j.target_id];
    if (!course) return;
    if (!course.chapters.length) buildStructure(course);
    for (const mid of j.material_ids) {
      const m = S.materials[mid];
      if (!m || m.status === 'failed') continue;
      if (m._broken) {
        Object.assign(m, { status: 'failed', stage: null, progress: null, pages: null, error: { message: '文件已损坏或不是有效的文档，换一份再上传', retryable: false } });
        continue;
      }
      Object.assign(m, { status: 'ready', stage: null, progress: null, kp_count: 4 + (m.title.length % 9) * 3 });
      if (/\.pptx?$/i.test(m.title)) { m.vision = 'partial'; m.vision_done_at = now() + 20000; }
      else m.vision = 'done';
    }
  }
  if (j.kind === 'focus') {
    const course = S.courses[j.target_id];
    if (!course) return;
    course.focus.fragments = analyze(course, course.focus.text);
    course.focus.choices = {};
    course.focus.analyzed_at = iso();
    course.focus.job_id = null;
    if (course.plan) course.plan.stale = true;
  }
}

/* ======================= 重点分析（演示用关键词规则） ======================= */

function analyze(course, text) {
  // 先按句号分句，再按逗号分成小句；没有命中关键词的小句并回前一个（“RAID 了解一下就行，不会考”是一句）
  const hits = (c) => FOCUS_KEYWORDS.some(([words]) => words.some((w) => c.toLowerCase().includes(w.toLowerCase())));
  const parts = [];
  for (const sent of text.split(/[。！？；;!?\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const clauses = [];
    for (const c of sent.split(/[，,]/).map((x) => x.trim()).filter(Boolean)) {
      if (clauses.length && !hits(c)) clauses[clauses.length - 1] += '，' + c;
      else if (clauses.length && !hits(clauses[clauses.length - 1])) clauses[clauses.length - 1] += '，' + c;
      else clauses.push(c);
    }
    parts.push(...clauses);
  }
  const titleToId = Object.fromEntries(Object.values(course.kps || {}).map((k) => [k.title, k.id]));
  return parts.map((sentence, i) => {
    const level = EXCLUDE_WORDS.some((w) => sentence.includes(w)) ? 'excluded'
      : EMPH_WORDS.some((w) => sentence.includes(w)) ? 'emphasized' : 'mentioned';
    const sure = new Set(), maybe = new Set();
    const low = sentence.toLowerCase();
    for (const [words, hit] of FOCUS_KEYWORDS) {
      if (!words.some((w) => low.includes(w.toLowerCase()))) continue;
      hit.sure.forEach((t) => sure.add(t));
      hit.maybe.forEach((t) => maybe.add(t));
    }
    const kps = [];
    for (const t of sure) if (titleToId[t]) kps.push({ id: titleToId[t], title: t, level, certainty: 'sure' });
    for (const t of maybe) if (titleToId[t] && !sure.has(t)) kps.push({ id: titleToId[t], title: t, level, certainty: 'maybe' });
    return { id: `f${i + 1}`, text: sentence, found: kps.length > 0, kps };
  });
}

function kpLevels(course) {
  const levels = {};
  const choices = course.focus.choices || {};
  for (const f of course.focus.fragments) {
    for (const k of f.kps) {
      const choice = choices[k.id] ?? null;
      const active = choice === null ? k.certainty === 'sure' : choice;
      if (!active) continue;
      (levels[k.id] ||= new Set()).add(k.level);
    }
  }
  const out = {};
  for (const [kid, set] of Object.entries(levels)) {
    const resolved = course.focus.resolved?.[kid];
    if (set.has('excluded') && set.has('emphasized')) out[kid] = resolved || 'conflict';
    else if (set.has('excluded') && set.size === 1) out[kid] = 'excluded';
    else out[kid] = set.has('emphasized') ? 'emphasized' : 'mentioned';
  }
  return out;
}

function conflictSuggestions(course) {
  const levels = kpLevels(course);
  return Object.entries(levels).filter(([, l]) => l === 'conflict').map(([kid]) => ({
    id: `sc_${kid}`, kind: 'focus_conflict',
    title: `“${course.kps[kid].title}”一句说不考，另一句说要考`, detail: '暂时按“强调”安排。',
    options: [{ id: 'emphasized', label: '按强调' }, { id: 'excluded', label: '按不考' }],
    default_option: 'emphasized', material_ids: [], kp_ids: [kid],
  }));
}

function limitedBasis(course) {
  const levels = kpLevels(course);
  return Object.keys(levels).length === 0 && !course.chapters.some((ch) => ch.topics.some((t) => t.homework));
}

/* ======================= 视图 ======================= */

function topicMinutes(t, course, levels) {
  const total = t.kp_ids.length;
  const excluded = t.kp_ids.filter((k) => levels[k] === 'excluded').length;
  const raw = Math.max(15, t.pages * 2 + (t.compute || 0) * 10);
  return Math.max(excluded === total ? 0 : 15, Math.round((raw * (total - excluded) / total) / 5) * 5);
}

function topicsView(course) {
  const levels = kpLevels(course);
  return {
    limited_basis: limitedBasis(course),
    chapters: course.chapters.map((ch) => ({
      id: ch.id, title: ch.title,
      topics: ch.topics.map((t) => {
        const kps = t.kp_ids.map((kid) => {
          const k = course.kps[kid];
          const level = levels[kid] || 'none';
          return { id: kid, title: k.title, level, modes: [], mastery: k.mastery, basis: level !== 'none' ? 'teacher' : t.homework ? 'homework' : 'limited' };
        });
        return {
          id: t.id, title: t.title, summary: null, minutes: topicMinutes(t, course, levels),
          mastery: { mastered: kps.filter((k) => k.mastery === 'mastered').length, shaky: kps.filter((k) => k.mastery === 'shaky').length, total: kps.length },
          kps,
        };
      }),
    })),
  };
}

function steps(course) {
  const mats = Object.values(S.materials).filter((m) => m.course_id === course.id);
  const sugg = Object.values(S.suggestions).filter((s) => s.course_id === course.id && !s.answered);
  const materials = !mats.length ? 'todo' : mats.some((m) => m.status === 'reading' || m.status === 'extracting') ? 'doing'
    : (sugg.length || mats.some((m) => m.status === 'failed')) ? 'attention' : 'done';
  const focus = course.focus.job_id ? 'doing' : conflictSuggestions(course).length ? 'attention' : course.focus.analyzed_at ? 'done' : 'todo';
  const plan = !course.plan ? 'todo' : course.plan.stale ? 'attention' : 'done';
  const exams = course.exams.map((e) => S.exams[e]).filter(Boolean);
  const practice = !exams.length ? 'todo' : exams.some((e) => e.status !== 'finished') ? 'doing' : 'done';
  return { materials, focus, plan, practice };
}

function courseView(c) {
  const st = steps(c);
  const days_left = c.exam_date ? daysBetween(dateISO(0), c.exam_date) : null;
  const active_jobs = Object.values(S.jobs).filter((j) => j.status === 'running' && (j.target_id === c.id || c.exams.includes(j.target_id))).map(jobView);
  const hasMats = Object.values(S.materials).some((m) => m.course_id === c.id);
  return {
    id: c.id, name: c.name, exam_date: c.exam_date, days_left, steps: st, active_jobs,
    next_step: !hasMats ? 'materials' : 'plan',
  };
}

function materialView(m) {
  const { course_id, vision_done_at, _broken, ...rest } = m;
  return clone(rest);
}

/* ======================= 计划（演示用的简化算法，规则见 v2 3.1） ======================= */

function computePlan(course) {
  const p = course.plan;
  const levels = kpLevels(course);
  const budget = p.days * p.hours_per_day * 60;
  const reserved = Math.round(budget * 0.2 / 5) * 5;
  const studyBudget = budget - reserved;
  const titleOf = {};
  const rows = [];
  course.chapters.forEach((ch, ci) => ch.topics.forEach((t, ti) => {
    titleOf[t.id] = t.title;
    const kps = t.kp_ids.map((k) => ({ ...course.kps[k], level: levels[k] || 'none' }));
    const mult = kps.reduce((s, k) => s + MULT[k.level], 0) / kps.length;
    const coef = kps.reduce((s, k) => s + MASTERY_COEF[k.mastery], 0) / kps.length;
    const weight = mult * coef + (t.homework ? 0.15 : 0);
    const minutes = topicMinutes(t, course, levels);
    rows.push({
      t, ch, order: ci * 100 + ti, weight, minutes, kps,
      allExcluded: kps.every((k) => k.level === 'excluded'),
      pinned: p.pins[t.id] || null,
    });
  }));

  const view = (r, reasons) => ({
    topic_id: r.t.id, title: r.t.title, chapter_title: r.ch.title, minutes: r.minutes, reasons, pinned: r.pinned,
    mastery: { mastered: r.kps.filter((k) => k.mastery === 'mastered').length, total: r.kps.length },
    focus_kps: r.kps.filter((k) => k.level !== 'none').map((k) => ({ id: k.id, title: k.title, level: k.level })),
  });
  const reasonsFor = (r) => {
    const out = [];
    if (r.kps.some((k) => k.level === 'emphasized' || k.level === 'conflict')) out.push('老师强调');
    else if (r.kps.some((k) => k.level === 'mentioned')) out.push('老师提及');
    if (r.t.homework) out.push('作业考过');
    if (r.kps.some((k) => k.mastery === 'shaky')) out.push('有做错过的知识点');
    if (r.kps.some((k) => k.level === 'excluded')) out.push('部分内容不考，已扣除');
    if (!out.length) out.push('依据有限');
    return out;
  };

  const must = [], maybe = [], drop = [];
  const chosen = new Set();
  let used = 0;
  const take = (r, extra = []) => { chosen.add(r.t.id); used += r.minutes; must.push({ r, reasons: [...extra, ...reasonsFor(r)] }); };

  for (const r of rows.filter((r) => r.pinned === 'must')) take(r, ['你固定为必学']);
  const candidates = rows.filter((r) => !r.pinned && !r.allExcluded).sort((a, b) => b.weight / b.minutes - a.weight / a.minutes);
  const rest = [];
  for (const r of candidates) {
    if (used + r.minutes <= studyBudget) {
      take(r);
      const pre = r.t.pre && rows.find((x) => x.t.id === r.t.pre);
      if (pre && !chosen.has(pre.t.id) && !pre.allExcluded && pre.pinned !== 'drop' && pre.kps.some((k) => k.mastery !== 'mastered')) take(pre, [`是“${r.t.title}”的前置`]);
    } else rest.push(r);
  }
  let maybeUsed = 0;
  for (const r of rest) {
    if (chosen.has(r.t.id)) continue;
    if (maybeUsed + r.minutes <= studyBudget * 0.35) { maybeUsed += r.minutes; maybe.push(view(r, [r.kps.some((k) => k.level !== 'none') ? reasonsFor(r)[0] : '老师未提及', `约需 ${r.minutes} 分钟`])); }
    else drop.push(view(r, [r.kps.every((k) => k.level === 'none') ? '未提及且耗时长' : '时间不够']));
  }
  for (const r of rows.filter((r) => r.pinned === 'drop')) drop.push(view(r, ['你选择了放弃']));
  for (const r of rows.filter((r) => !r.pinned && r.allExcluded)) drop.push(view(r, ['老师说不考']));

  // 排期：按章节顺序，计算类主题后面紧跟练习；最后留给模拟卷和错题
  const ordered = must.slice().sort((a, b) => a.r.order - b.r.order);
  const items = [];
  for (const { r } of ordered) {
    const practice = Math.min((r.t.compute || 0) * 10, r.minutes - 10);
    items.push({ id: `pi_${r.t.id}_study`, topic_id: r.t.id, title: r.t.title, minutes: r.minutes - Math.max(0, practice), kind: 'study' });
    if (practice > 0) items.push({ id: `pi_${r.t.id}_practice`, topic_id: r.t.id, title: `练习：${r.t.title}`, minutes: practice, kind: 'practice' });
  }
  const daily = p.hours_per_day * 60;
  const schedule = Array.from({ length: p.days }, (_, i) => ({ date: dateISO(i, p.start_date), items: [] }));
  const studyDays = Math.max(1, p.days - Math.max(1, Math.round(p.days * 0.2)));
  const totalStudy = items.reduce((s, it) => s + it.minutes, 0);
  const target = Math.min(daily, Math.ceil(totalStudy / studyDays));   // 均匀摊开，不把内容都塞进前几天
  let d = 0, load = 0;
  for (const it of items) {
    if (load > 0 && load + it.minutes > target * 1.15 && d < studyDays - 1) { d++; load = 0; }
    schedule[d].items.push(it); load += it.minutes;
  }
  const mockMin = Math.min(120, Math.round(reserved * 0.6 / 5) * 5);
  const reviewMin = reserved - mockMin;
  const last = schedule[schedule.length - 1];
  if (p.days > 1) schedule[Math.max(studyDays, schedule.length - 1)].items.push({ id: 'pi_mock', topic_id: null, title: '模拟卷', minutes: mockMin, kind: 'mock' });
  else last.items.push({ id: 'pi_mock', topic_id: null, title: '短模拟题', minutes: mockMin, kind: 'mock' });
  last.items.push({ id: 'pi_review', topic_id: null, title: '复习错题和不稳的知识点', minutes: reviewMin, kind: 'review' });
  for (const day of schedule) for (const it of day.items) it.done = !!p.done[it.id];

  return {
    id: p.id, days: p.days, hours_per_day: p.hours_per_day, start_date: p.start_date,
    total_min: budget, reserved_min: reserved, limited_basis: limitedBasis(course), stale: !!p.stale,
    buckets: { must: must.sort((a, b) => a.r.order - b.r.order).map(({ r, reasons }) => view(r, reasons)), maybe, drop },
    schedule,
  };
}

/* ======================= 试卷 ======================= */

function poolFor(course, scope, topicTitle) {
  let pool = QUESTION_POOL.map((q, i) => ({ q, i }));
  if (topicTitle) { const hit = pool.filter(({ q }) => q.topic === topicTitle); if (hit.length) return hit.map(({ q }) => q); }
  if (scope === 'mistakes') {
    const shaky = new Set(Object.values(course.kps).filter((k) => k.mastery === 'shaky').map((k) => k.title));
    const hit = pool.filter(({ q }) => q.kps.some((t) => shaky.has(t)));
    if (hit.length) pool = hit;
  } else if (scope === 'plan' && course.plan) {
    const must = new Set(computePlan(course).buckets.must.map((t) => t.title));
    pool.sort((a, b) => (must.has(b.q.topic) - must.has(a.q.topic)) || a.i - b.i);
  }
  return pool.map(({ q }) => q);
}

function buildQuestion(tpl, index, course) {
  const qid = id('q');
  const titleToId = Object.fromEntries(Object.values(course.kps).map((k) => [k.title, k.id]));
  const mat = S.materials[tpl.ref[0]];
  return {
    id: qid, index, type: tpl.type, status: 'generating', score: tpl.score, topic_title: tpl.topic,
    stem: tpl.stem, options: tpl.options ? tpl.options.map(([oid, text]) => ({ id: oid, text })) : null,
    refs: mat ? [{ material_id: mat.id, material_title: mat.title, page: tpl.ref[1] }] : [],
    hints: tpl.hints || [], checked: true, attempt: null, peeked: false, _hint: tpl.hint || null,
    kp_ids: tpl.kps.map((t) => titleToId[t]).filter(Boolean),
    _key: tpl.key ?? null,
    solution: {
      answer: tpl.answer,
      steps: tpl.steps.map((blocks, i) => ({ n: i + 1, blocks, refs: i === 0 && mat ? [{ material_id: mat.id, material_title: mat.title, page: tpl.ref[1] }] : [] })),
      rubric: tpl.rubric ? tpl.rubric.map(([point, score], i) => ({ id: `${qid}_r${i + 1}`, point, score })) : null,
    },
  };
}

function createExam(course, count, scope, { instant = false, title, offsetMs = 0, topicTitle } = {}) {
  const pool = poolFor(course, scope, topicTitle);
  const n = Math.min(count, pool.length);
  const eid = id('e');
  const t0 = now();
  const e = {
    id: eid, course_id: course.id, title: title || `第 ${course.exams.length + 1} 套`,
    created_at: iso(t0 + offsetMs), status: instant ? 'ready' : 'generating', job_id: null,
    format_basis: course.format.basis, score: null, changes: [], result: null,
    questions: pool.slice(0, n).map((tpl, i) => buildQuestion(tpl, i + 1, course)),
  };
  e.questions.forEach((q, i) => { q._ready_at = t0 + 1200 + i * 1400; q._verified_at = q._ready_at + 1600; if (instant) q.status = 'ready'; });
  S.exams[eid] = e;
  course.exams.unshift(eid);
  if (!instant) {
    const j = newJob('exam', eid, 1200 + n * 1400 + 1700, ['出题中', '验证中']);
    e.job_id = j.id;
  }
  return e;
}

function advanceExam(e, t) {
  if (!e || e.status !== 'generating') return;
  for (const q of e.questions) {
    if (q.status === 'generating' && t >= q._ready_at) q.status = 'verifying';
    if (q.status === 'verifying' && t >= q._verified_at) q.status = 'ready';
  }
  if (e.questions.every((q) => q.status !== 'generating' && q.status !== 'verifying')) { e.status = 'ready'; e.job_id = null; }
}

function qView(q) {
  const { kp_ids, _key, _ready_at, _verified_at, _hint, _changes, ...rest } = q;
  const v = clone(rest);
  if (!q.attempt) v.solution = null;
  if (q.status === 'generating') { v.stem = []; v.options = null; }
  return v;
}
function examView(e) {
  const qs = e.questions.map(qView);
  return {
    id: e.id, title: e.title, created_at: e.created_at, status: e.status,
    job: e.job_id ? jobView(S.jobs[e.job_id]) : null, format_basis: e.format_basis,
    questions: qs, score: e.score, total: e.questions.filter((q) => q.status !== 'hidden').reduce((s, q) => s + q.score, 0),
  };
}

const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/[次个分]$/, '').toUpperCase();

function bumpMastery(course, q, correct) {
  const changes = [];
  if (correct && q.peeked) return changes;   // 看过答案：答对也不计为做对
  for (const kid of q.kp_ids) {
    const k = course.kps[kid];
    if (!k) continue;
    const from = k.mastery;
    if (correct) { k.correct = (k.correct || 0) + 1; k.mastery = k.correct >= 2 ? 'mastered' : 'shaky'; }
    else { k.correct = 0; k.mastery = 'shaky'; }
    if (from !== k.mastery) changes.push({ kp_id: kid, title: k.title, from, to: k.mastery });
  }
  return changes;
}

function doAttempt(q, response, course) {
  if (q.status !== 'ready' && q.status !== 'disputed') throw new HttpError(409, 'conflict', '这道题还没准备好');
  if (q.attempt) throw new HttpError(409, 'conflict', '这道题已经答过了');
  const objective = q.type === 'single' || q.type === 'fill';
  let changes = [];
  if (objective) {
    const correct = norm(response) !== '' && norm(response) === norm(q._key);
    q.attempt = { response, state: 'graded', correct, score: correct ? q.score : 0, marks: null };
    changes = bumpMastery(course, q, correct);
  } else {
    const correct = q.type === 'calc' && q._key ? norm(response) === norm(q._key) : null;
    q.attempt = { response, state: 'needs_self_grade', correct, score: correct ? q.score : null, marks: null };
  }
  q._changes = changes;
  return { attempt: clone(q.attempt), solution: clone(q.solution), mastery_changes: changes };
}

function doGrade(q, marks, course) {
  if (!q.attempt) throw new HttpError(409, 'conflict', '先提交作答再自评');
  const rubric = q.solution.rubric || [];
  for (const r of rubric) if (!['full', 'partial', 'none'].includes(marks[r.id])) throw new HttpError(400, 'bad_request', '每个评分点都要选一项');
  const score = rubric.reduce((s, r) => s + (marks[r.id] === 'full' ? r.score : marks[r.id] === 'partial' ? r.score / 2 : 0), 0);
  const first = q.attempt.state !== 'graded';
  q.attempt = { ...q.attempt, state: 'graded', score, marks, correct: q.attempt.correct ?? (score >= q.score * 0.8) };
  const changes = first ? bumpMastery(course, q, score >= q.score * 0.8) : [];
  q._changes = changes;
  return { attempt: clone(q.attempt), solution: clone(q.solution), mastery_changes: changes };
}

function finish(e, course) {
  if (e.result) return e.result;
  e.status = 'finished';
  const live = e.questions.filter((q) => q.status !== 'hidden');
  e.score = live.reduce((s, q) => s + (q.attempt?.score || 0), 0);
  const merged = {};
  for (const q of live) for (const c of q._changes || []) merged[c.kp_id] = merged[c.kp_id] ? { ...merged[c.kp_id], to: c.to } : { ...c };
  const changes = Object.values(merged).filter((c) => c.from !== c.to);
  if (course.plan && changes.length) course.plan.stale = true;
  e.result = { mastery_changes: changes, plan_stale: !!course.plan?.stale };
  return e.result;
}

/* ======================= 路由 ======================= */

const getCourse = (cid) => S.courses[cid] || (() => { throw notFound('课程'); })();
const getExam = (eid) => S.exams[eid] || (() => { throw notFound('试卷'); })();
function getQuestion(qid) {
  for (const e of Object.values(S.exams)) { const q = e.questions.find((x) => x.id === qid); if (q) return { q, e, course: S.courses[e.course_id] }; }
  throw notFound('题目');
}
const OK_EXT = /\.(pdf|pptx?|docx?|txt|md)$/i;

export const routes = [
  ['GET', /^\/health$/, () => ({ ok: true, model: '演示模型', mock_model: true })],
  ['GET', /^\/jobs\/([^/]+)$/, ([jid]) => jobView(S.jobs[jid] || (() => { throw notFound('任务'); })())],
  ['POST', /^\/jobs\/([^/]+)\/retry$/, ([jid]) => { const j = S.jobs[jid]; if (!j) throw notFound('任务'); j.status = 'running'; j.started = now(); j.applied = false; return jobView(j); }],

  ['GET', /^\/courses$/, () => S.order.map((cid) => courseView(S.courses[cid])).sort((a, b) => (a.exam_date || '9999') < (b.exam_date || '9999') ? -1 : 1)],
  ['POST', /^\/courses$/, (_, b) => {
    const name = String(b?.name || '').trim();
    if (!name) throw new HttpError(400, 'bad_request', '课程名不能为空');
    const cid = id('c');
    S.courses[cid] = { id: cid, name, exam_date: b.exam_date || null, created_at: iso(), format: clone(DEFAULT_FORMAT), focus: { text: '', analyzed_at: null, job_id: null, fragments: [], choices: {}, resolved: {} }, plan: null, exams: [], chapters: [], kps: {} };
    S.order.push(cid);
    return courseView(S.courses[cid]);
  }],
  ['GET', /^\/courses\/([^/]+)$/, ([cid]) => courseView(getCourse(cid))],
  ['PATCH', /^\/courses\/([^/]+)$/, ([cid], b) => { const c = getCourse(cid); if (b.name != null) c.name = String(b.name).trim() || c.name; if (b.exam_date !== undefined) c.exam_date = b.exam_date || null; return courseView(c); }],
  ['DELETE', /^\/courses\/([^/]+)$/, ([cid]) => {
    const c = getCourse(cid);
    for (const m of Object.values(S.materials)) if (m.course_id === cid) delete S.materials[m.id];
    for (const s of Object.values(S.suggestions)) if (s.course_id === cid) delete S.suggestions[s.id];
    for (const e of c.exams) delete S.exams[e];
    if (S.chats) delete S.chats[cid];
    delete S.courses[cid]; S.order = S.order.filter((x) => x !== cid);
    return null;
  }],

  ['GET', /^\/courses\/([^/]+)\/materials$/, ([cid]) => {
    getCourse(cid);
    return {
      materials: Object.values(S.materials).filter((m) => m.course_id === cid).sort((a, b) => a.uploaded_at < b.uploaded_at ? -1 : 1).map(materialView),
      suggestions: Object.values(S.suggestions).filter((s) => s.course_id === cid && !s.answered).map(({ course_id, answered, ...s }) => clone(s)),
    };
  }],
  ['POST', /^\/courses\/([^/]+)\/materials$/, ([cid], fd) => {
    const c = getCourse(cid);
    const files = fd instanceof FormData ? fd.getAll('files') : [];
    if (!files.length) throw new HttpError(400, 'bad_request', '没有收到文件');
    const bad = files.find((f) => !OK_EXT.test(f.name));
    if (bad) throw new HttpError(415, 'unsupported_type', `不支持“${bad.name}”的格式。可以上传 PDF、PPT、Word、TXT 或 Markdown`);
    const created = files.map((f) => {
      const mid = id('m');
      const kind = /作业|homework|hw/i.test(f.name) ? 'homework' : /笔记|note/i.test(f.name) ? 'notes' : /往年|试卷|真题/.test(f.name) ? 'past_paper' : /\.(pptx?|pdf)$/i.test(f.name) ? 'slides' : 'other';
      const m = { id: mid, course_id: cid, title: f.name, kind, pages: 6 + (f.name.length * 7) % 80, status: 'reading', stage: '读取文字', progress: 0, kp_count: null, vision: 'none', superseded_by: null, error: null, uploaded_at: iso(), _broken: fileOk.get(`${f.name}|${f.size}`) === false };
      S.materials[mid] = m;
      if (/复习|提纲|review/i.test(f.name)) {
        const sid = id('s');
        S.suggestions[sid] = { id: sid, course_id: cid, kind: 'role', title: `“${f.name}”像是老师的复习材料`, detail: '按老师重点处理后，里面的内容会算作强调。', options: [{ id: 'review', label: '按老师重点处理' }, { id: 'other', label: '当普通资料' }], default_option: 'other', material_ids: [mid], kp_ids: [], answered: false };
      }
      return m;
    });
    const j = newJob('ingest', cid, 5000 + created.length * 1500, ['读取文字', c.chapters.length ? '整理知识点' : '整理知识点（演示数据使用示例课程结构）', '分组成主题']);
    j.material_ids = created.map((m) => m.id);
    if (c.plan) c.plan.stale = true;
    return { materials: created.map(materialView), job: jobView(j) };
  }],
  ['PATCH', /^\/materials\/([^/]+)$/, ([mid], b) => { const m = S.materials[mid]; if (!m) throw notFound('资料'); if (b.kind) m.kind = b.kind; return materialView(m); }],
  ['DELETE', /^\/materials\/([^/]+)$/, ([mid]) => {
    const m = S.materials[mid]; if (!m) throw notFound('资料');
    delete S.materials[mid];
    for (const s of Object.values(S.suggestions)) if (s.material_ids.includes(mid)) delete S.suggestions[s.id];
    for (const x of Object.values(S.materials)) if (x.superseded_by === mid) x.superseded_by = null;
    const c = S.courses[m.course_id];
    if (c && !Object.values(S.materials).some((x) => x.course_id === c.id)) { c.chapters = []; c.kps = {}; }
    if (c?.plan) c.plan.stale = true;
    return null;
  }],
  ['GET', /^\/materials\/([^/]+)\/pages\/(\d+)$/, ([mid, n]) => {
    const m = S.materials[mid]; if (!m) throw notFound('资料');
    return { material_id: mid, page: +n, image_url: null, text: `（演示数据）${m.title} 第 ${n} 页\n\n接入后端后，这里显示这一页的原页截图；没有截图时显示文字层和图示转写结果。` };
  }],
  ['POST', /^\/suggestions\/([^/]+)$/, ([sid], b) => {
    if (sid.startsWith('sc_')) {
      const kid = sid.slice(3);
      for (const c of Object.values(S.courses)) if (c.kps?.[kid]) { c.focus.resolved[kid] = b.choice; if (c.plan) c.plan.stale = true; }
      return { ok: true };
    }
    const s = S.suggestions[sid]; if (!s) throw notFound('建议');
    if (!s.options.some((o) => o.id === b.choice)) throw new HttpError(400, 'bad_request', '选项不认识');
    s.answered = true;
    if (s.kind === 'version') {
      for (const mid of s.material_ids) S.materials[mid] && (S.materials[mid].superseded_by = mid === b.choice ? null : b.choice);
    }
    if (s.kind === 'role') for (const mid of s.material_ids) S.materials[mid] && (S.materials[mid].kind = b.choice);
    return { ok: true };
  }],

  ['GET', /^\/courses\/([^/]+)\/topics$/, ([cid]) => topicsView(getCourse(cid))],

  ['GET', /^\/courses\/([^/]+)\/focus$/, ([cid]) => focusView(getCourse(cid))],
  ['PUT', /^\/courses\/([^/]+)\/focus$/, ([cid], b) => {
    const c = getCourse(cid);
    c.focus.text = String(b?.text ?? '');
    if (!c.focus.text.trim()) { c.focus.fragments = []; c.focus.analyzed_at = null; c.focus.job_id = null; if (c.plan) c.plan.stale = true; return focusView(c); }
    const j = newJob('focus', cid, 3800, ['把每句话对应到主题', '在主题里选出知识点', '多次选择取多数']);
    c.focus.job_id = j.id;
    return focusView(c);
  }],
  ['POST', /^\/courses\/([^/]+)\/focus\/kps$/, ([cid], b) => {
    const c = getCourse(cid);
    if (!c.kps[b.kp_id]) throw notFound('知识点');
    if (b.include === null) delete c.focus.choices[b.kp_id]; else c.focus.choices[b.kp_id] = !!b.include;
    if (c.plan) c.plan.stale = true;
    return focusView(c);
  }],
  ['GET', /^\/courses\/([^/]+)\/exam-format$/, ([cid]) => clone(getCourse(cid).format)],
  ['PUT', /^\/courses\/([^/]+)\/exam-format$/, ([cid], b) => {
    const c = getCourse(cid);
    if (!Array.isArray(b?.types)) throw new HttpError(400, 'bad_request', '缺少题型');
    c.format = { types: b.types.map((t) => ({ type: t.type, count: Math.max(0, +t.count || 0), score: Math.max(0, +t.score || 0) })), duration_min: b.duration_min ?? null, open_book: b.open_book ?? null, basis: 'user' };
    return clone(c.format);
  }],

  ['GET', /^\/courses\/([^/]+)\/plan$/, ([cid]) => { const c = getCourse(cid); return { plan: c.plan && c.chapters.length ? computePlan(c) : null }; }],
  ['POST', /^\/courses\/([^/]+)\/plan$/, ([cid], b) => {
    const c = getCourse(cid);
    if (!c.chapters.length) throw new HttpError(409, 'conflict', '先上传资料，整理出知识点后才能排计划');
    const days = Math.round(+b.days), hours = +b.hours_per_day;
    if (!(days >= 1 && days <= 60) || !(hours > 0 && hours <= 16)) throw new HttpError(400, 'bad_request', '天数要在 1 到 60 之间，每天 0 到 16 小时');
    c.plan = { id: c.plan?.id || id('p'), days, hours_per_day: hours, start_date: b.start_date || dateISO(0), pins: c.plan?.pins || {}, done: c.plan?.done || {}, stale: false };
    return computePlan(c);
  }],
  ['POST', /^\/courses\/([^/]+)\/plan\/pins$/, ([cid], b) => {
    const c = getCourse(cid); if (!c.plan) throw new HttpError(409, 'conflict', '还没有计划');
    if (b.pin) c.plan.pins[b.topic_id] = b.pin; else delete c.plan.pins[b.topic_id];
    return computePlan(c);
  }],
  ['POST', /^\/plan-items\/([^/]+)$/, ([itemId], b) => {
    const c = Object.values(S.courses).find((x) => x.plan && computePlan(x).schedule.some((d) => d.items.some((i) => i.id === itemId)));
    if (!c) throw notFound('计划项');
    c.plan.done[itemId] = !!b.done;
    for (const d of computePlan(c).schedule) for (const i of d.items) if (i.id === itemId) return i;
    return null;
  }],

  ['GET', /^\/courses\/([^/]+)\/exams$/, ([cid]) => getCourse(cid).exams.map((eid) => S.exams[eid]).filter(Boolean).map((e) => {
    const v = examView(e);
    return { id: v.id, title: v.title, created_at: v.created_at, status: v.status, question_count: v.questions.filter((q) => q.status !== 'hidden').length, answered: v.questions.filter((q) => q.attempt).length, score: v.score, total: v.total };
  })],
  ['POST', /^\/courses\/([^/]+)\/exams$/, ([cid], b) => {
    const c = getCourse(cid);
    if (!c.chapters.length) throw new HttpError(409, 'conflict', '先上传资料，整理出知识点后才能出题');
    const count = [5, 10, 20].includes(+b.count) ? +b.count : 10;
    return examView(createExam(c, count, b.scope || 'plan'));
  }],
  ['GET', /^\/exams\/([^/]+)$/, ([eid]) => examView(getExam(eid))],
  ['POST', /^\/exams\/([^/]+)\/finish$/, ([eid]) => { const e = getExam(eid); const r = finish(e, S.courses[e.course_id]); return { exam: examView(e), ...clone(r) }; }],
  ['GET', /^\/exams\/([^/]+)\/result$/, ([eid]) => { const e = getExam(eid); if (!e.result) throw new HttpError(409, 'conflict', '这套题还没完成'); return { exam: examView(e), ...clone(e.result) }; }],
  ['POST', /^\/questions\/([^/]+)\/attempt$/, ([qid], b) => { const { q, course } = getQuestion(qid); return doAttempt(q, b?.response ?? null, course); }],
  ['POST', /^\/questions\/([^/]+)\/grade$/, ([qid], b) => { const { q, course } = getQuestion(qid); return doGrade(q, b?.marks || {}, course); }],
  ['POST', /^\/questions\/([^/]+)\/report$/, ([qid]) => { const { q } = getQuestion(qid); q.status = 'hidden'; q._changes = []; return { status: 'hidden' }; }],
];

function focusView(c) {
  const job = c.focus.job_id ? jobView(S.jobs[c.focus.job_id]) : null;
  const choices = c.focus.choices || {};
  return {
    text: c.focus.text, analyzed_at: c.focus.analyzed_at, job,
    fragments: c.focus.fragments.map((f) => ({ ...f, kps: f.kps.map((k) => ({ ...k, user_choice: choices[k.id] ?? null })) })),
    suggestions: conflictSuggestions(c).filter((s) => !c.focus.resolved?.[s.kp_ids[0]]),
  };
}

/** 给演示对话（chat.js）用的内部接口 */
export const internal = {
  get S() { return S; }, save, tick, id, iso, now, clone, HttpError, notFound,
  getCourse, getExam, getQuestion, computePlan, createExam, examView, jobView, newJob, focusView, topicsView, kpLevels,
};
export const registerRoutes = (list) => routes.push(...list);

/** 与真实后端相同的调用方式：失败时抛出带 message 的错误 */
const MAGIC = { pdf: '%PDF', docx: 'PK', pptx: 'PK' };
const fileOk = new Map();   // “文件名|大小” → 文件头是否像真的（演示用：损坏的文件在整理时记为失败）

export async function mockRequest(method, path, body) {
  if (body instanceof FormData) {
    for (const f of body.getAll('files')) {
      const ext = (f.name.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
      const head = new TextDecoder('latin1').decode(await f.slice(0, 4).arrayBuffer());
      fileOk.set(`${f.name}|${f.size}`, !MAGIC[ext] || head.startsWith(MAGIC[ext]));
    }
  }
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 160));
  tick();
  const clean = path.split('?')[0];
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const hit = clean.match(re);
    if (!hit) continue;
    try {
      const out = fn(hit.slice(1).map(decodeURIComponent), body);
      save();
      return clone(out);
    } catch (err) {
      if (err instanceof HttpError) { const e = new Error(err.message); e.status = err.status; e.code = err.code; throw e; }
      throw err;
    }
  }
  const e = new Error(`演示后端没有实现 ${method} ${clean}`); e.status = 404; throw e;
}

S = load();
