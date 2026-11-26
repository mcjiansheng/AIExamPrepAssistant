// 课程、知识点、资料、老师重点：建课、掌握度规则（09 第 8 节）、重点映射的演示版、各视图。
import type * as T from '../api/types';
import { CONTENT, EMPH_WORDS, EXCLUDE_WORDS, type ContentCourse, T as text } from './content';
import {
  addDays, byId, daysBetween, db, nowIso, today, uid,
  type BankRow, type CourseRow, type FragmentRow, type KpRow, type MaterialRow, type UserRow,
} from './db';

export const LEVEL_WEIGHT: Record<T.Level, number> = { emphasized: 4, conflict: 4, mentioned: 2.5, none: 1, excluded: 0 };
export const FOCUS_LEVELS: T.Level[] = ['emphasized', 'conflict', 'mentioned'];

const ALIASES: Record<ContentCourse['key'], Record<string, string>> = {
  os: { 移臂: '磁盘调度', 磁盘调度: '磁盘调度', 页面置换: '虚拟存储与页面置换', 置换算法: '虚拟存储与页面置换', 管程: '管程', RAID: 'RAID 与磁盘高速缓存', 进程调度: '处理机调度' },
  math: { 中值定理: '中值定理', 换元积分: '不定积分', 洛必达: '洛必达法则' },
  ds: { 最短路径: '图的应用', 排序算法: '排序', 遍历: '二叉树' },
};

const norm = (s: string) => s.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLowerCase();
const SUFFIX = /(的概念与特征|的原理与组成|的必要条件|的概念与性质|的定义|的概念|的性质|的应用|的分类|与连续|问题|算法|机制|方式|技术|法则|公式|定理|实现互斥|各级别|系统概念)$/u;

function keywords(title: string) {
  const out = new Set<string>([norm(title)]);
  const stripped = norm(title.replace(SUFFIX, ''));
  if (stripped.length >= 2) out.add(stripped);
  for (const latin of title.match(/[A-Za-z]{2,}/g) ?? []) out.add(latin.toLowerCase());
  return [...out].filter((w) => w.length >= 2);
}

// —— 建课 ——
export interface CourseOptions { name?: string; examInDays: number | null; sample: boolean; color: number; withFocus: boolean; ingest: boolean }

export function instantiateCourse(user: UserRow, content: ContentCourse, opts: CourseOptions): CourseRow {
  const created_at = nowIso();
  const course: CourseRow = {
    id: uid('c'), user_id: user.id, name: opts.name ?? content.name, color: opts.color,
    exam_date: opts.examInDays === null ? null : addDays(today(), opts.examInDays), sample: opts.sample,
    daily_cap_min: null, created_at, content: content.key,
    organizing: { state: 'idle', progress: null, stage: null, job_id: null, attention: null },
    format: { ...structuredClone(content.format), basis: opts.withFocus ? 'teacher' : 'default' }, ingested: false,
  };
  db.courses.push(course);
  db.threads.push({
    id: uid('th'), user_id: user.id, course_id: course.id, title: course.name, kind: 'course', model: null,
    updated_at: created_at, preview: null,
  });
  if (opts.ingest) {
    const materials = content.materials.map((m) => addMaterial(user, course, m.title, m.kind, 'ready', m.pages));
    buildStructure(course, content, materials);
    if (opts.withFocus) addFocus(course, content.focus, true);
  }
  return course;
}

export function addMaterial(user: UserRow, course: CourseRow, title: string, kind: T.MaterialKind, status: T.Material['status'], pages: number | null): MaterialRow {
  const row: MaterialRow = {
    id: uid('m'), user_id: user.id, course_id: course.id, title, kind, source: kind === 'photo' ? 'photo' : 'file', pages,
    status, stage: null, progress: status === 'ready' ? 1 : 0, kp_count: 0, question_count: 0,
    vision: status === 'ready' ? 'done' : 'none', superseded_by: null, decision: null, skipped_pages: [], error: null,
    uploaded_at: nowIso(),
  };
  db.materials.push(row);
  return row;
}

/** 按内容模板生成章、主题、知识点、课件页和题库（演示后端代替真实的资料整理） */
export function buildStructure(course: CourseRow, content: ContentCourse, materials: MaterialRow[]) {
  const byKey = new Map(content.materials.map((m, i) => [m.key, materials[i] ?? materials[0]!]));
  const cursor = new Map<string, number>();
  let order = 0;
  content.chapters.forEach((chapter, ci) => {
    const ch = { id: uid('ch'), course_id: course.id, title: chapter.title, order: ci };
    db.chapters.push(ch);
    const material = byKey.get(chapter.material) ?? materials[0]!;
    chapter.topics.forEach((topic, ti) => {
      const kpsInTopic = topic.kps.length;
      const minutes = Math.max(15, topic.pages * 2 + topic.kps.filter((kp) => kp.modes?.includes('compute')).length * 10);
      const tp = { id: uid('tp'), course_id: course.id, chapter_id: ch.id, title: topic.title, order: ti, minutes, homework: !!topic.homework };
      db.topics.push(tp);
      const start = cursor.get(material.id) ?? 3;
      cursor.set(material.id, start + topic.pages);
      addPage(material.id, start, topic.title, [`${chapter.title} · ${topic.title}`, ...topic.kps.map((kp) => kp.t)], []);
      topic.kps.forEach((kp, ki) => {
        const page = start + 1 + Math.floor((ki * Math.max(1, topic.pages - 1)) / kpsInTopic);
        const row: KpRow = {
          id: uid('kp'), course_id: course.id, chapter_id: ch.id, topic_id: tp.id, title: kp.t, order: order++, summary: kp.s,
          modes: kp.modes ?? ['understand'], level: 'none', refs: [{ material_id: material.id, page }],
          understood_at: null, mark: null, stability: null, due: null,
        };
        db.kps.push(row);
        const existing = db.pages.find((p) => p.material_id === material.id && p.page === page);
        if (existing) {
          existing.kp_ids.push(row.id);
          existing.lines.push(kp.t, ...sentences(kp.s));
        } else addPage(material.id, page, kp.t, sentences(kp.s), [row.id]);
      });
    });
  });
  for (const material of materials) {
    if (material.kind === 'homework' || material.kind === 'review') {
      // 作业和复习题：每页一道题，指向相关主题的知识点，作为“作业考过”“老师的复习材料”的出处
      const related = db.kps.filter((kp) => kp.course_id === course.id && (material.kind === 'review'
        ? kp.modes.includes('major') || kp.modes.includes('proof')
        : db.topics.find((t) => t.id === kp.topic_id)?.homework));
      related.forEach((kp, i) => {
        const page = i + 2;
        addPage(material.id, page, `第 ${i + 1} 题 · ${kp.title}`, [`结合课件完成：${kp.summary}`], [kp.id]);
        kp.refs.push({ material_id: material.id, page });
      });
      cursor.set(material.id, related.length + 2);
    }
    const used = cursor.get(material.id) ?? 3;
    const total = Math.max(material.pages ?? used, used - 1);
    material.pages = total;
    addPage(material.id, 1, material.title.replace(/\.\w+$/, ''), [course.name, ...content.chapters.filter((c) => byKey.get(c.material) === material).map((c) => c.title)], []);
    if (!db.pages.some((p) => p.material_id === material.id && p.page === 2)) {
      addPage(material.id, 2, '目录', db.topics.filter((t) => t.course_id === course.id && db.pages.some((p) => p.material_id === material.id && p.title === t.title)).map((t) => t.title), []);
    }
    for (let p = 3; p <= total; p += 1) {
      if (!db.pages.some((row) => row.material_id === material.id && row.page === p)) addPage(material.id, p, '小结与习题', ['回顾本节的要点，完成课后习题。'], []);
    }
  }
  buildBank(course, content);
  refreshMaterialCounts(course.id);
  course.ingested = true;
}

function addPage(materialId: T.ID, page: number, title: string, lines: string[], kpIds: T.ID[]) {
  db.pages.push({ material_id: materialId, page, title, lines, kp_ids: kpIds });
}

function sentences(s: string) {
  return s.split(/(?<=[。；])/u).map((x) => x.trim()).filter(Boolean);
}

function firstClause(s: string) {
  return (s.split(/[，；。]/u)[0] ?? s).trim();
}

function buildBank(course: CourseRow, content: ContentCourse) {
  const kps = db.kps.filter((k) => k.course_id === course.id);
  for (const q of content.questions) {
    const kp = kps.find((k) => k.title === q.kp);
    if (!kp) continue;
    db.bank.push({
      id: uid('q'), course_id: course.id, kp_id: kp.id, type: q.type, score: q.score, stem: q.stem,
      options: q.options?.map(([id, t]) => ({ id, text: t })) ?? null, key: q.key ?? null, answer: q.answer, steps: q.steps,
      rubric: q.rubric?.map(([point, score], i) => ({ id: `r${i + 1}`, point, score })) ?? null, hints: q.hints, authored: true,
      refs: kp.refs,
    });
  }
  for (const kp of kps) {
    const chapterKps = kps.filter((k) => k.chapter_id === kp.chapter_id && k.id !== kp.id);
    const siblings = [...chapterKps.filter((k) => k.topic_id === kp.topic_id), ...chapterKps.filter((k) => k.topic_id !== kp.topic_id)];
    if (siblings.length >= 3) {
      const letters = ['A', 'B', 'C', 'D'];
      const correct = kp.order % 4;
      const others = siblings.slice(0, 3);
      const options = letters.map((id, i) => {
        const source = i === correct ? kp : others[i < correct ? i : i - 1]!;
        return { id, text: firstClause(source.summary) };
      });
      db.bank.push({
        id: uid('q'), course_id: course.id, kp_id: kp.id, type: 'single', score: 2,
        stem: [text(`下列哪一项说的是“${kp.title}”？`)], options, key: letters[correct]!, answer: letters[correct]!,
        steps: [[text(`“${kp.title}”：${kp.summary}`)], [text(`其他选项分别说的是：${others.map((o) => `“${o.title}”`).join('、')}。`)]],
        rubric: null, hints: [`回想这一节里“${kp.title}”是怎么定义的。`, '逐个判断每个选项说的是哪个知识点，排除不相关的。'],
        authored: false, refs: kp.refs,
      });
    }
    const parts = kp.summary.split(/[；]/u).filter(Boolean);
    const points = (parts.length >= 2 ? parts : kp.summary.split(/[，]/u).filter(Boolean)).slice(0, 3);
    const each = Math.floor(6 / points.length);
    db.bank.push({
      id: uid('q'), course_id: course.id, kp_id: kp.id, type: 'short', score: 6,
      stem: [text(`用自己的话说明“${kp.title}”。`)], options: null, key: null, answer: kp.summary,
      steps: [[text(kp.summary)]],
      rubric: points.map((p, i) => ({ id: `r${i + 1}`, point: p.replace(/。$/u, ''), score: i === points.length - 1 ? 6 - each * (points.length - 1) : each })),
      hints: ['先说它是什么，再说它有什么特点或怎么用。', `可以从课件里“${kp.title}”这一页的第一句话入手。`], authored: false, refs: kp.refs,
    });
  }
}

export function refreshMaterialCounts(courseId: T.ID) {
  for (const m of db.materials.filter((x) => x.course_id === courseId)) {
    const kpIds = new Set(db.kps.filter((k) => k.course_id === courseId && k.refs.some((r) => r.material_id === m.id)).map((k) => k.id));
    m.kp_count = m.status === 'ready' ? kpIds.size : null;
    m.question_count = db.bank.filter((b) => kpIds.has(b.kp_id)).length;
  }
}

// —— 老师重点（两步映射的演示版：关键词 + 别名，代码定级别） ——
export function addFocus(course: CourseRow, raw: string, analyzeNow: boolean): FragmentRow[] {
  const parts = raw.split(/(?<=[。！？!?；;\n])/u).map((s) => s.trim()).filter((s) => s.length > 1);
  const rows = parts.map((t) => {
    const row: FragmentRow = { id: uid('fr'), course_id: course.id, text: t, found: false, created_at: nowIso(), analyzed: false, kps: [] };
    db.fragments.push(row);
    return row;
  });
  if (analyzeNow) analyzeFragments(course);
  return rows;
}

export function analyzeFragments(course: CourseRow) {
  const kps = db.kps.filter((k) => k.course_id === course.id);
  const topics = db.topics.filter((t) => t.course_id === course.id);
  const aliases = ALIASES[course.content];
  for (const fr of db.fragments.filter((f) => f.course_id === course.id && !f.analyzed)) {
    const sentence = norm(fr.text);
    const level: 'excluded' | 'mentioned' | 'emphasized' = EXCLUDE_WORDS.some((w) => fr.text.includes(w))
      ? 'excluded' : EMPH_WORDS.some((w) => fr.text.includes(w)) ? 'emphasized' : 'mentioned';
    const picked = new Map<T.ID, 'sure' | 'maybe'>();
    for (const kp of kps) if (keywords(kp.title).some((w) => sentence.includes(w))) picked.set(kp.id, 'sure');
    for (const [alias, topicTitle] of Object.entries(aliases)) {
      if (!sentence.includes(norm(alias))) continue;
      const topic = topics.find((t) => t.title === topicTitle);
      const inTopic = kps.filter((k) => k.topic_id === topic?.id);
      inTopic.forEach((k, i) => { if (!picked.has(k.id)) picked.set(k.id, i === 0 && inTopic.length > 2 ? 'maybe' : 'sure'); });
    }
    for (const id of [...picked.keys()]) {
      const kp = kps.find((k) => k.id === id)!;
      const next = kps.find((k) => k.topic_id === kp.topic_id && k.order === kp.order + 1);
      if (next && !picked.has(next.id) && picked.get(id) === 'sure' && level !== 'excluded') picked.set(next.id, 'maybe');
    }
    fr.kps = [...picked].map(([id, certainty]) => ({ id, level, certainty, user_choice: null }));
    fr.found = fr.kps.length > 0;
    fr.analyzed = true;
  }
  recomputeLevels(course.id);
}

export function recomputeLevels(courseId: T.ID) {
  const fragments = db.fragments.filter((f) => f.course_id === courseId && f.analyzed);
  const votes = new Map<T.ID, Set<'excluded' | 'mentioned' | 'emphasized'>>();
  for (const fr of fragments) {
    for (const k of fr.kps) {
      const included = k.user_choice ?? k.certainty === 'sure';
      if (!included) continue;
      let set = votes.get(k.id);
      if (!set) votes.set(k.id, (set = new Set()));
      set.add(k.level);
    }
  }
  for (const kp of db.kps.filter((k) => k.course_id === courseId)) {
    const set = votes.get(kp.id) ?? new Set();
    let level: T.Level = 'none';
    if (set.has('excluded') && set.has('emphasized')) {
      let conflict = db.conflicts.find((c) => c.course_id === courseId && c.kp_id === kp.id);
      if (!conflict) {
        conflict = { id: uid('cf'), course_id: courseId, kp_id: kp.id, text: `关于“${kp.title}”，一句说不考，一句说强调`, choice: null };
        db.conflicts.push(conflict);
      }
      level = conflict.choice ?? 'conflict';
    } else if (set.has('emphasized')) level = 'emphasized';
    else if (set.has('mentioned')) level = 'mentioned';
    else if (set.has('excluded')) level = 'excluded';
    kp.level = level;
  }
}

// —— 掌握度（09 第 8.1 节）——
export function kpStates(courseId: T.ID): Map<T.ID, T.KpState> {
  const byKp = new Map<T.ID, typeof db.events>();
  for (const e of db.events) {
    if (!e.counted) continue;
    let list = byKp.get(e.kp_id);
    if (!list) byKp.set(e.kp_id, (list = []));
    list.push(e);
  }
  const out = new Map<T.ID, T.KpState>();
  for (const kp of db.kps) {
    if (kp.course_id !== courseId) continue;
    out.set(kp.id, stateOf(kp, byKp.get(kp.id) ?? []));
  }
  return out;
}

export function stateOf(kp: KpRow, events: typeof db.events): T.KpState {
  let state: T.KpState = kp.understood_at ? 'learned' : 'new';
  const correct = new Set<T.ID>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.outcome === 'correct') {
      correct.add(e.bank_id);
      if (correct.size >= 2 || kp.mark === 'mastered') state = 'mastered';
      else if (state === 'new') state = 'learned';
    } else {
      state = 'shaky';
      correct.clear();
    }
  }
  if (kp.mark === 'shaky' && state !== 'mastered') state = 'shaky';
  return state;
}

export function readiness(courseId: T.ID, states = kpStates(courseId)) {
  const kps = db.kps.filter((k) => k.course_id === courseId && k.level !== 'excluded');
  const focus = kps.filter((k) => FOCUS_LEVELS.includes(k.level));
  const pool = focus.length > 0 ? focus : kps;
  return { mastered: pool.filter((k) => states.get(k.id) === 'mastered').length, total: pool.length };
}

// —— 视图 ——
export function courseView(c: CourseRow): T.Course {
  const states = kpStates(c.id);
  return {
    id: c.id, name: c.name, color: c.color, exam_date: c.exam_date,
    days_left: c.exam_date ? daysBetween(today(), c.exam_date) : null, sample: c.sample,
    readiness: readiness(c.id, states), organizing: c.organizing,
    counts: {
      kps: db.kps.filter((k) => k.course_id === c.id).length,
      materials: db.materials.filter((m) => m.course_id === c.id && !m.superseded_by).length,
      fragments: db.fragments.filter((f) => f.course_id === c.id).length,
      mistakes: db.mistakes.filter((m) => m.course_id === c.id && !m.removed).length,
    },
    daily_cap_min: c.daily_cap_min, created_at: c.created_at,
  };
}

export function mapView(courseId: T.ID, states = kpStates(courseId)): T.CourseMap {
  return {
    course_id: courseId,
    chapters: db.chapters.filter((c) => c.course_id === courseId).sort((a, b) => a.order - b.order).map((ch) => chapterView(ch.id, states)),
  };
}

export function chapterView(chapterId: T.ID, states: Map<T.ID, T.KpState>): T.MapChapter {
  const ch = byId('chapters', chapterId)!;
  const kps = db.kps.filter((k) => k.chapter_id === chapterId).sort((a, b) => a.order - b.order);
  return {
    id: ch.id, title: ch.title,
    mastered: kps.filter((k) => states.get(k.id) === 'mastered').length, total: kps.length,
    kps: kps.map((k) => ({ id: k.id, title: k.title, state: states.get(k.id) ?? 'new', level: k.level, topic_id: k.topic_id })),
  };
}

export function kpBrief(kp: KpRow, states?: Map<T.ID, T.KpState>): T.KpBrief {
  const s = states ?? kpStates(kp.course_id);
  return { id: kp.id, course_id: kp.course_id, title: kp.title, state: s.get(kp.id) ?? 'new', level: kp.level, chapter_title: byId('chapters', kp.chapter_id)?.title ?? '' };
}

export function weakKps(courseId: T.ID, limit = 3, states = kpStates(courseId)): T.KpBrief[] {
  return db.kps
    .filter((k) => k.course_id === courseId && states.get(k.id) === 'shaky' && k.level !== 'excluded')
    .sort((a, b) => LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] || a.order - b.order)
    .slice(0, limit)
    .map((k) => kpBrief(k, states));
}

export function refView(ref: { material_id: T.ID; page: number }, quote: string | null = null): T.Ref {
  return { material_id: ref.material_id, material_title: byId('materials', ref.material_id)?.title ?? '课件', page: ref.page, quote };
}

export function materialView(m: MaterialRow): T.Material {
  const { user_id: _u, ...rest } = m;
  return rest;
}

export function pageView(materialId: T.ID, page: number): T.Page | null {
  const m = byId('materials', materialId);
  const row = db.pages.find((p) => p.material_id === materialId && p.page === page);
  if (!m || !row) return null;
  const states = kpStates(m.course_id);
  return {
    material_id: m.id, material_title: m.title, page, total: m.pages ?? page,
    text: [row.title, ...row.lines].join('\n'), image_url: null,
    kps: row.kp_ids.map((id) => byId('kps', id)).filter((k): k is KpRow => !!k).map((k) => kpBrief(k, states)),
  };
}

export function focusView(course: CourseRow): T.Focus {
  const kps = new Map(db.kps.filter((k) => k.course_id === course.id).map((k) => [k.id, k]));
  const job = db.jobs.find((j) => j.course_id === course.id && j.kind === 'focus' && (j.status === 'queued' || j.status === 'running'));
  return {
    course_id: course.id,
    fragments: db.fragments.filter((f) => f.course_id === course.id).map((f) => ({
      id: f.id, text: f.text, found: f.found, created_at: f.created_at,
      kps: f.kps.filter((k) => kps.has(k.id)).map((k) => ({
        id: k.id, title: kps.get(k.id)!.title, level: k.level, certainty: k.certainty, user_choice: k.user_choice,
        included: k.user_choice ?? k.certainty === 'sure',
      })),
    })),
    conflicts: db.conflicts.filter((c) => c.course_id === course.id && c.choice === null).map((c) => ({
      id: c.id, kp_id: c.kp_id, title: kps.get(c.kp_id)?.title ?? '', text: c.text, choice: c.choice,
    })),
    job: job ? jobView(job) : null,
  };
}

export function jobView(j: (typeof db.jobs)[number]): T.Job {
  const { user_id: _u, due: _d, payload: _p, ...rest } = j;
  return rest;
}

export function questionTypesFor(kp: KpRow): T.QuestionType[] {
  const types = new Set<T.QuestionType>(db.bank.filter((b) => b.kp_id === kp.id).map((b) => b.type));
  return [...types];
}

export function explainFor(kp: KpRow): T.Block[][] {
  const course = byId('courses', kp.course_id);
  const content = course ? CONTENT[course.content] : null;
  const authored = content?.explain[kp.title];
  if (authored && authored.length > 0) return authored;
  const topic = byId('topics', kp.topic_id);
  const siblings = db.kps.filter((k) => k.topic_id === kp.topic_id && k.id !== kp.id).map((k) => k.title);
  const blocks: T.Block[][] = [[text(kp.summary)]];
  if (topic && siblings.length) blocks.push([text(`它属于「${topic.title}」，这一节还有：${siblings.join('、')}。`)]);
  return blocks;
}

export function bankForKp(kpId: T.ID): BankRow[] {
  return db.bank.filter((b) => b.kp_id === kpId).sort((a, b) => Number(b.authored) - Number(a.authored));
}

export function contentKeys(): ContentCourse['key'][] {
  return Object.keys(CONTENT) as ContentCourse['key'][];
}
