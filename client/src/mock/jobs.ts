// 后台任务的演示：出题（先出后核）、资料整理、重点分析、导出。按时间推进，通过事件流通知页面。
import type * as T from '../api/types';
import { changed, emit } from './bus';
import { contentFor } from './content';
import { analyzeFragments, buildStructure, jobView, refreshMaterialCounts } from './course';
import { byId, db, nowIso, persist, uid, type JobRow, type MaterialRow } from './db';
import { planUser } from './plan';
import { questionView } from './practice';

const STAGES = ['读取资料', '抽取知识点', '分组成主题', '分析老师重点', '排进日程'];

export function newJob(userId: T.ID, kind: T.Job['kind'], courseId: T.ID | null, targetId: T.ID, payload: Record<string, unknown>, delay = 400): JobRow {
  const job: JobRow = {
    id: uid('j'), user_id: userId, kind, status: 'queued', progress: 0, stage: null, error: null, course_id: courseId,
    target_id: targetId, result: null, created_at: nowIso(), due: Date.now() + delay, payload,
  };
  db.jobs.push(job);
  return job;
}

function notify(userId: T.ID, kind: T.Notification['kind'], title: string, body: string | null, href: string | null) {
  const n = { id: uid('n'), user_id: userId, kind, title, body, href, created_at: nowIso(), read: false };
  db.notifications.push(n);
  const { user_id: _u, ...view } = n;
  emit(userId, { type: 'notification', notification: view });
}

function tickSessions(now: number) {
  let dirty = false;
  for (const s of db.sessions) {
    if (s.status === 'finished' || s.status === 'failed') continue;
    const items = db.items.filter((i) => i.session_id === s.id);
    for (const item of items) {
      if (item.status === 'pending' && now >= item.ready_at) {
        item.status = 'ready';
        dirty = true;
        if (s.status === 'preparing') { s.status = 'active'; s.started_at = nowIso(); }
        emit(s.user_id, { type: 'question', session_id: s.id, question: questionView(item) });
      }
      if (item.status === 'ready' && item.check === 'checking' && now >= item.check_at) {
        dirty = true;
        if (s.kind === 'mock' && item.index === 3 && item.version === 1) {
          if (item.attempt) {
            item.check = 'flagged';
            item.check_note = '核对发现参考解析里有一步和课件不一致，这道题不计分';
          } else {
            const current = byId('bank', item.bank_id)!;
            const swap = db.bank.find((b) => b.course_id === current.course_id && b.type === current.type && b.id !== current.id && !items.some((i) => i.bank_id === b.id));
            if (swap) item.bank_id = swap.id;
            item.version += 1;
            item.replaced = true;
            item.check_at = now + 1500;
          }
        } else item.check = 'passed';
        emit(s.user_id, { type: 'question', session_id: s.id, question: questionView(item) });
      }
    }
    const job = s.job_id ? db.jobs.find((j) => j.id === s.job_id) : undefined;
    if (job && job.status === 'running') {
      const ready = items.filter((i) => i.status !== 'pending').length;
      job.progress = items.length ? ready / items.length : 1;
      job.stage = ready < items.length ? `出题中（${ready}/${items.length}）` : null;
      if (ready === items.length) {
        job.status = 'done';
        emit(s.user_id, { type: 'job', job: jobView(job) });
      }
    }
  }
  return dirty;
}

function classify(title: string): { kind: T.MaterialKind; role: string | null } {
  if (/\.(png|jpe?g|heic)$/i.test(title)) return { kind: 'photo', role: null };
  if (/复习|提纲|重点/.test(title)) return { kind: 'review', role: '按老师的复习材料处理' };
  if (/往年|真题|试卷/.test(title)) return { kind: 'past_paper', role: '按往年卷处理' };
  if (/作业|习题/.test(title)) return { kind: 'homework', role: null };
  if (/笔记/.test(title)) return { kind: 'notes', role: null };
  return { kind: 'slides', role: null };
}

const baseName = (title: string) => title.replace(/\.\w+$/, '').replace(/[（(]\d+[)）]|[-_ ]?(v\d+|最终版|终版|修订版|新版)$/giu, '').trim();

function finishMaterial(m: MaterialRow) {
  const { kind, role } = classify(m.title);
  m.kind = kind;
  m.status = 'ready';
  m.progress = 1;
  m.stage = null;
  m.vision = 'done';
  if (/加密/.test(m.title)) {
    m.status = 'failed';
    m.error = { message: '文件已加密，请解除密码后重新上传', retryable: false };
    m.kp_count = null;
    return;
  }
  if (/扫描/.test(m.title)) m.skipped_pages = [12, 13];
  const older = db.materials.find((x) => x.course_id === m.course_id && x.id !== m.id && !x.superseded_by && x.status === 'ready' && baseName(x.title) === baseName(m.title));
  if (older) {
    older.superseded_by = m.id;
    m.decision = { kind: 'version', text: '已用较新的版本', options: [{ id: 'new', label: '用新版本' }, { id: 'old', label: '用旧版本' }, { id: 'both', label: '两份都用' }], choice: 'new' };
    for (const kp of db.kps.filter((k) => k.course_id === m.course_id)) {
      for (const ref of kp.refs) if (ref.material_id === older.id) ref.material_id = m.id;
    }
    for (const page of db.pages.filter((p) => p.material_id === older.id)) db.pages.push({ ...structuredClone(page), material_id: m.id });
    m.pages = older.pages;
  } else if (role) {
    m.decision = { kind: 'role', text: role, options: [{ id: 'keep', label: role.replace('按', '').replace('处理', '') }, { id: 'slides', label: '普通课件' }], choice: 'keep' };
  }
}

function tickIngest(job: JobRow, now: number) {
  const course = job.course_id ? byId('courses', job.course_id) : undefined;
  const ids = (job.payload.material_ids as T.ID[]) ?? [];
  const materials = ids.map((id) => byId('materials', id)).filter((m): m is MaterialRow => !!m);
  if (!course || !materials.length) { job.status = 'done'; return; }
  const step = (job.payload.step as number) ?? 0;
  job.status = 'running';
  if (step < STAGES.length) {
    const progress = (step + 1) / (STAGES.length + 1);
    job.progress = progress;
    job.stage = step === 1 ? `抽取知识点（${Math.min(materials.length, 1 + Math.floor(progress * materials.length))}/${materials.length} 份）` : STAGES[step]!;
    for (const m of materials) {
      if (m.status === 'failed') continue;
      m.status = step === 0 ? 'reading' : 'extracting';
      m.progress = progress;
      m.stage = job.stage;
    }
    course.organizing = { state: 'working', progress, stage: job.stage, job_id: job.id, attention: null };
    job.payload.step = step + 1;
    job.due = now + 900;
    changed(job.user_id, ['materials', 'course', 'courses'], course.id);
    return;
  }
  for (const m of materials) if (m.status !== 'failed') finishMaterial(m);
  if (!course.ingested) {
    const usable = db.materials.filter((m) => m.course_id === course.id && m.status === 'ready' && !m.superseded_by);
    if (usable.length) {
      buildStructure(course, contentFor(course.name), usable);
      for (const m of usable) m.pages = Math.max(m.pages ?? 0, db.pages.filter((p) => p.material_id === m.id).length);
    }
  }
  analyzeFragments(course);
  refreshMaterialCounts(course.id);
  const attention = materials.filter((m) => m.status === 'failed' || m.skipped_pages.length).length;
  course.organizing = { state: attention ? 'attention' : 'idle', progress: null, stage: null, job_id: null, attention: attention ? `${attention} 份资料要看` : null };
  job.status = 'done';
  job.progress = 1;
  job.stage = null;
  const user = byId('users', job.user_id);
  if (user) planUser(user, true);
  const kps = db.kps.filter((k) => k.course_id === course.id).length;
  if (user?.reminders.jobs) notify(job.user_id, 'job_done', `${course.name}的资料整理完了`, kps ? `整理出 ${kps} 个知识点` : null, `/c/${course.id}`);
  emit(job.user_id, { type: 'job', job: jobView(job) });
  changed(job.user_id, ['materials', 'course', 'courses', 'map', 'focus', 'today', 'schedule'], course.id);
}

function tickJob(job: JobRow, now: number) {
  if (job.kind === 'ingest') return tickIngest(job, now);
  if (job.kind === 'focus') {
    const course = job.course_id ? byId('courses', job.course_id) : undefined;
    if (course?.ingested) analyzeFragments(course);
    job.status = 'done';
    const user = byId('users', job.user_id);
    if (user) planUser(user, true);
    emit(job.user_id, { type: 'job', job: jobView(job) });
    changed(job.user_id, ['focus', 'map', 'course', 'courses', 'today', 'schedule'], job.course_id);
    return;
  }
  if (job.kind === 'export') {
    const data = {
      exported_at: nowIso(),
      courses: db.courses.filter((c) => c.user_id === job.user_id).map((c) => c.name),
      sessions: db.sessions.filter((s) => s.user_id === job.user_id).length,
    };
    const url = typeof URL !== 'undefined' && typeof Blob !== 'undefined' && 'createObjectURL' in URL
      ? URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })) : null;
    job.status = 'done';
    job.progress = 1;
    job.result = { url };
    emit(job.user_id, { type: 'job', job: jobView(job) });
    notify(job.user_id, 'job_done', '数据导出好了', '点开下载', '/me/data');
    return;
  }
  if (job.kind === 'agent') {
    const steps = (job.payload.steps as number) ?? 3;
    const step = ((job.payload.step as number) ?? 0) + 1;
    job.payload.step = step;
    job.status = step >= steps ? 'done' : 'running';
    job.progress = step / steps;
    job.due = now + 1200;
    emit(job.user_id, { type: 'job', job: jobView(job) });
  }
}

export function tick(now = Date.now()) {
  let dirty = tickSessions(now);
  for (const job of db.jobs) {
    if ((job.status === 'queued' || job.status === 'running') && job.kind !== 'session' && now >= job.due) {
      tickJob(job, now);
      dirty = true;
    }
  }
  if (dirty) persist();
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startTicker() {
  if (!timer) timer = setInterval(() => tick(), 300);
}
