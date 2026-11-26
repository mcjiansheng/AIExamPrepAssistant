// 演示后端的路由：按 api-v1.md 实现每个接口，返回真正的 Response（含 NDJSON 流），前端代码与连真实后端时完全相同。
import type * as T from '../api/types';
import { changed, emit } from './bus';
import { PLUGINS, PRESETS } from './catalog';
import { respond } from './chat';
import { contentFor } from './content';
import {
  addMaterial, analyzeFragments, chapterView, courseView, focusView, jobView, kpBrief, kpStates, mapView, materialView,
  pageView, recomputeLevels, refView, explainFor, questionTypesFor, weakKps,
} from './course';
import { addDays, byId, daysBetween, db, nowIso, persist, removeWhere, resetDb, today, uid, type CourseRow, type KpRow, type UserRow } from './db';
import { mockConfig, wait as pause } from './config';
import { ApiErr } from './errors';
import { newJob } from './jobs';
import { planUser, replanTracked, scheduleView, taskView, todayView } from './plan';
import {
  attempt, createSession, finish, grade, hasAi, hint, insightView, kpQuizSession, mistakesView, practiceHub, questionView,
  report, sessionView, similarSession, summaryView,
} from './practice';
import { createUser, DEMO_PHONE } from './seed';
import { applyUndo, withUndo } from './undo';

type Body = Record<string, unknown>;
interface Ctx { user: UserRow; body: Body; params: string[]; query: URLSearchParams; form: FormData | null; token: string | null; deviceId: T.ID | null }
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; pattern: RegExp; handler: Handler; open: boolean }

const routes: Route[] = [];
const add = (method: string, path: string, handler: Handler, open = false) => {
  routes.push({ method, pattern: new RegExp(`^${path.replace(/\{\w+\}/g, '([^/]+)')}$`), handler, open });
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const errorResponse = (e: ApiErr) => json({ error: { code: e.code, message: e.message, hint: null, detail: e.detail } }, e.status);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const change = <R>(result: R, affects: T.Area[], undo: T.Undo | null = null): T.Change<R> => ({ result, affects, undo });

function own<K extends 'courses' | 'materials' | 'sessions' | 'threads'>(table: K, id: T.ID, user: UserRow, label: string) {
  const row = byId(table, id) as { user_id: T.ID } | undefined;
  if (!row || row.user_id !== user.id) throw new ApiErr(404, 'not_found', `${label}不存在`);
  return row as unknown as (typeof db)[K][number];
}
function ownKp(id: T.ID, user: UserRow): KpRow {
  const kp = byId('kps', id);
  if (!kp || byId('courses', kp.course_id)?.user_id !== user.id) throw new ApiErr(404, 'not_found', '知识点不存在');
  return kp;
}
function writer(user: UserRow) {
  if (user.guest) throw new ApiErr(403, 'login_required', '登录后才能保存自己的课程');
}
function userView(u: UserRow): T.User {
  const { phone: _p, demo: _d, settings: _s, reminders: _r, limits: _l, models: _m, today_minutes: _t, day_minutes: _dm, resume: _re, planned_on: _po, notice: _n, ...rest } = u;
  return rest;
}
function issue(user: UserRow, device: T.DeviceInfo, isNew: boolean): T.Tokens {
  const dev = { id: uid('dv'), user_id: user.id, kind: device.kind, name: device.name, last_seen: nowIso() };
  db.devices.push(dev);
  const access = `at_${uid('t')}`;
  const refresh = `rt_${uid('t')}`;
  db.tokens.push({ token: access, user_id: user.id, kind: 'access', device_id: dev.id }, { token: refresh, user_id: user.id, kind: 'refresh', device_id: dev.id });
  return { access_token: access, refresh_token: refresh, expires_in: 900, user: userView(user), is_new: isNew };
}
function deviceOf(body: Body): T.DeviceInfo {
  const d = body.device as T.DeviceInfo | undefined;
  return d ?? { kind: 'browser', name: '浏览器', timezone: 'Asia/Shanghai' };
}
const providerView = (p: (typeof db.providers)[number]): T.Connection => {
  const { user_id: _u, key: _k, ...rest } = p;
  return rest;
};
const courseOf = (user: UserRow, cid: T.ID) => own('courses', cid, user, '课程') as CourseRow;
const nextColor = (user: UserRow) => {
  const used = db.courses.filter((c) => c.user_id === user.id).map((c) => c.color);
  for (let i = 0; i < 8; i += 1) if (!used.includes(i)) return i;
  return used.length % 8;
};
function relative(date: string) {
  const d = daysBetween(today(), date);
  return d === 0 ? '今天' : d === 1 ? '明天' : d === 2 ? '后天' : `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

// —— 健康、撤销、任务 ——
add('GET', '/health', () => ({ ok: true, version: '1.0-mock', capabilities: { ocr: true, speech: false }, sms: 'dev' }), true);
add('POST', '/undo/{id}', ({ user, params }) => {
  const row = applyUndo(user, params[0]!);
  planUser(user);
  changed(user.id, row.affects);
  return { ok: true, affects: row.affects, summary: row.summary };
});
add('GET', '/jobs/{id}', ({ user, params }) => {
  const job = db.jobs.find((j) => j.id === params[0] && j.user_id === user.id);
  if (!job) throw new ApiErr(404, 'not_found', '任务不存在');
  return jobView(job);
});
add('POST', '/jobs/{id}/retry', ({ user, params }) => {
  const job = db.jobs.find((j) => j.id === params[0] && j.user_id === user.id);
  if (!job) throw new ApiErr(404, 'not_found', '任务不存在');
  if (job.status !== 'failed' || !job.error?.retryable) throw new ApiErr(409, 'conflict', '这项任务当前不能重试');
  job.status = 'queued';
  job.error = null;
  job.due = Date.now() + 300;
  return jobView(job);
});

// —— 认证 ——
const smsSent = new Map<string, number>();
const smsWrong = new Map<string, { n: number; until: number }>();
add('POST', '/auth/sms', ({ body }) => {
  const phone = str(body.phone);
  if (!/^1\d{10}$/.test(phone)) throw new ApiErr(400, 'bad_request', '手机号格式不对');
  const last = smsSent.get(phone) ?? 0;
  const wait = 60 - Math.floor((Date.now() - last) / 1000);
  if (wait > 0) throw new ApiErr(429, 'rate_limited', `${wait} 秒后可以重发`, { retry_after_sec: wait });
  smsSent.set(phone, Date.now());
  return { cooldown_sec: 60, dev_code: '123456' };
}, true);
add('POST', '/auth/login', ({ body }) => {
  const phone = str(body.phone);
  const code = str(body.code);
  const lock = smsWrong.get(phone);
  if (lock && lock.until > Date.now()) throw new ApiErr(429, 'rate_limited', '错误次数太多，请 10 分钟后再试', { retry_after_sec: Math.ceil((lock.until - Date.now()) / 1000) });
  if (code !== '123456') {
    const n = (lock?.n ?? 0) + 1;
    smsWrong.set(phone, { n, until: n >= 5 ? Date.now() + 600_000 : 0 });
    throw new ApiErr(400, 'bad_request', n >= 5 ? '错误次数太多，请 10 分钟后再试' : `验证码错误，还可以试 ${5 - n} 次`);
  }
  smsWrong.delete(phone);
  let user = db.users.find((u) => u.phone === phone && !u.guest);
  const isNew = !user;
  if (!user) user = createUser(phone === DEMO_PHONE ? 'demo' : 'new', phone, deviceOf(body));
  return issue(user, deviceOf(body), isNew);
}, true);
add('POST', '/auth/guest', ({ body }) => issue(createUser('guest', null, deviceOf(body)), deviceOf(body), true), true);
add('POST', '/auth/huawei', () => { throw new ApiErr(409, 'conflict', '华为账号一键登录需要在鸿蒙设备上使用'); }, true);
add('POST', '/auth/qr', ({ body }) => {
  const row = { id: uid('qr'), status: 'waiting' as const, user_id: null, device: deviceOf(body), created: Date.now() };
  db.qr.push(row);
  return { id: row.id, payload: `fullgrid://login?qr=${row.id}`, expires_at: new Date(row.created + 120_000).toISOString() };
}, true);
add('GET', '/auth/qr/{id}', ({ params }) => {
  const row = db.qr.find((q) => q.id === params[0]);
  if (!row) throw new ApiErr(404, 'not_found', '二维码不存在');
  const age = Date.now() - row.created;
  if (age > 120_000) return { status: 'expired', tokens: null };
  // 演示：第 4 秒“手机已扫码”，第 7 秒“手机已确认”，登录演示账号
  if (age > 7_000) {
    let user = db.users.find((u) => u.phone === DEMO_PHONE);
    const isNew = !user;
    if (!user) user = createUser('demo', DEMO_PHONE, row.device);
    return { status: 'confirmed', tokens: issue(user, row.device, isNew) };
  }
  return { status: age > 4_000 ? 'scanned' : 'waiting', tokens: null };
}, true);
add('POST', '/auth/qr/{id}/scan', () => ({ device_name: '华为 Mate 手机' }));
add('POST', '/auth/qr/{id}/confirm', () => ({ ok: true }));
add('POST', '/auth/refresh', ({ body }) => {
  const row = db.tokens.find((t) => t.kind === 'refresh' && t.token === str(body.refresh_token));
  const user = row && byId('users', row.user_id);
  if (!row || !user) throw new ApiErr(401, 'unauthorized', '登录已过期，请重新登录');
  const access = `at_${uid('t')}`;
  db.tokens.push({ token: access, user_id: user.id, kind: 'access', device_id: row.device_id });
  return { access_token: access, refresh_token: row.token, expires_in: 900, user: userView(user), is_new: false };
}, true);
add('POST', '/auth/logout', ({ deviceId }) => { removeWhere('tokens', (t) => t.device_id === deviceId); });

// —— 我 ——
add('GET', '/me', ({ user }) => userView(user));
add('PATCH', '/me', ({ user, body }) => {
  for (const key of ['nickname', 'school', 'major', 'timezone'] as const) if (typeof body[key] === 'string') (user as unknown as Body)[key] = body[key];
  if (body.onboarding && typeof body.onboarding === 'object') user.onboarding = { ...user.onboarding, ...(body.onboarding as T.User['onboarding']) };
  return userView(user);
});
add('GET', '/me/stats', ({ user }) => {
  const since = addDays(today(), -6);
  const sessions = db.sessions.filter((s) => s.user_id === user.id && s.result && (s.finished_at ?? '') >= since);
  const learn = db.tasks.filter((t) => t.user_id === user.id && t.kind === 'learn' && t.status === 'done' && t.date >= since);
  const days = new Set(db.events.filter((e) => e.user_id === user.id).map((e) => e.at.slice(0, 10)));
  let streak = 0;
  for (let d = today(); days.has(d) || (d === today() && streak === 0 && days.has(addDays(d, -1))); d = addDays(d, -1)) { if (days.has(d)) streak += 1; if (streak > 60) break; }
  return { week_minutes: sessions.reduce((s, x) => s + Math.round((x.result?.duration_sec ?? 0) / 60), 0) + learn.reduce((s, t) => s + t.minutes, 0) + (user.demo ? 260 : 0), streak_days: streak };
});
add('GET', '/me/devices', ({ user, deviceId }) => db.devices.filter((d) => d.user_id === user.id).map(({ user_id: _u, ...d }) => ({ ...d, current: d.id === deviceId })).sort((a, b) => Number(b.current) - Number(a.current)));
add('DELETE', '/me/devices/{id}', ({ user, params }) => {
  removeWhere('devices', (d) => d.id === params[0] && d.user_id === user.id);
  removeWhere('tokens', (t) => t.device_id === params[0]);
});
add('POST', '/me/export', ({ user }) => jobView(newJob(user.id, 'export', null, user.id, {}, 1800)));
add('DELETE', '/me', ({ user }) => { user.deletion_at = new Date(Date.now() + 7 * 86_400_000).toISOString(); return { deletion_at: user.deletion_at }; });
add('POST', '/me/restore', ({ user }) => { user.deletion_at = null; return userView(user); });
add('PUT', '/me/resume', ({ user, body }) => {
  const kind = body.kind as 'kp' | 'session';
  const courseId = str(body.course_id);
  if (kind === 'kp') {
    const kp = byId('kps', str(body.kp_id));
    if (kp) user.resume = { kind, course_id: courseId, title: kp.title, detail: null, href: `/c/${courseId}/kp/${kp.id}`, updated_at: nowIso(), device: null };
  } else {
    const s = byId('sessions', str(body.session_id));
    if (s && s.status !== 'finished') {
      const n = db.items.filter((i) => i.session_id === s.id && i.status !== 'hidden').length;
      user.resume = { kind, course_id: courseId, title: s.title, detail: `第 ${Math.min(n, Number(body.position ?? 0) + 1)}/${n} 题`, href: `/session/${s.id}`, updated_at: nowIso(), device: null };
    }
  }
  if (user.resume) emit(user.id, { type: 'resume', resume: user.resume });
});
add('POST', '/feedback', ({ user, body }) => { db.feedback.push({ id: uid('fb'), user_id: user.id, kind: str(body.kind), text: str(body.text), created_at: nowIso() }); });

// —— 设置 ——
add('GET', '/me/settings', ({ user }) => user.settings);
add('PATCH', '/me/settings', ({ user, body }) => {
  const plan = 'daily_minutes' in body || 'intensity' in body;
  user.settings = { ...user.settings, ...(body as Partial<T.Settings>) };
  if (plan) planUser(user, true);
  return change(user.settings, plan ? ['settings', 'today', 'schedule'] : ['settings']);
});
add('GET', '/me/reminders', ({ user }) => user.reminders);
add('PUT', '/me/reminders', ({ user, body }) => { user.reminders = body as unknown as T.Reminders; return user.reminders; });
add('GET', '/me/memory', ({ user }) => db.memory.filter((m) => m.user_id === user.id).map(({ user_id: _u, ...m }) => m).reverse());
add('DELETE', '/me/memory/{id}', ({ user, params }) => removeWhere('memory', (m) => m.id === params[0] && m.user_id === user.id));
add('DELETE', '/me/memory', ({ user }) => removeWhere('memory', (m) => m.user_id === user.id));

// —— 模型 ——
add('GET', '/providers/presets', () => PRESETS, true);
add('GET', '/me/providers', ({ user }) => db.providers.filter((p) => p.user_id === user.id).map(providerView));
add('POST', '/me/providers', ({ user, body }) => {
  writer(user);
  const key = str(body.key).trim();
  if (key.length < 8) throw new ApiErr(400, 'bad_request', '密钥格式不对，请完整粘贴');
  const preset = PRESETS.find((p) => p.id === body.preset_id);
  if (body.preset_id && !preset) throw new ApiErr(400, 'bad_request', '服务商不存在');
  const row = {
    id: uid('pv'), user_id: user.id, key, preset_id: preset?.id ?? null, name: preset?.name ?? (str(body.name) || '自定义服务商'),
    protocol: (preset?.protocol ?? 'openai') as T.Protocol, base_url: preset?.base_url ?? str(body.base_url), key_last4: key.slice(-4),
    status: 'unchecked' as const, status_message: null, checked_at: null, capabilities: null,
    models: preset ? preset.models.map((m) => m.id) : [str(body.model) || 'default'],
  };
  db.providers.push(row);
  return providerView(row);
});
add('PATCH', '/me/providers/{id}', ({ user, params, body }) => {
  const p = db.providers.find((x) => x.id === params[0] && x.user_id === user.id);
  if (!p) throw new ApiErr(404, 'not_found', '连接不存在');
  if (typeof body.key === 'string') { p.key = body.key; p.key_last4 = body.key.slice(-4); p.status = 'unchecked'; }
  if (typeof body.name === 'string') p.name = body.name;
  if (typeof body.base_url === 'string') p.base_url = body.base_url;
  return providerView(p);
});
add('DELETE', '/me/providers/{id}', ({ user, params }) => {
  removeWhere('providers', (p) => p.id === params[0] && p.user_id === user.id);
  for (const role of Object.keys(user.models.roles) as T.Role[]) if (user.models.roles[role]?.connection_id === params[0]) user.models.roles[role] = null;
});
add('POST', '/me/providers/{id}/check', async ({ user, params }) => {
  const p = db.providers.find((x) => x.id === params[0] && x.user_id === user.id);
  if (!p) throw new ApiErr(404, 'not_found', '连接不存在');
  await pause(900);
  const preset = PRESETS.find((x) => x.id === p.preset_id);
  const steps: T.CheckStep[] = [];
  if (/bad|invalid|wrong/i.test(p.key)) {
    p.status = 'invalid'; p.status_message = '密钥无效：服务商返回“未授权”';
    steps.push({ id: 'connect', ok: false, message: p.status_message });
  } else if (/quota|empty/i.test(p.key)) {
    p.status = 'limited'; p.status_message = '服务商余额不足，充值后重试';
    steps.push({ id: 'connect', ok: false, message: p.status_message });
  } else {
    const model = preset?.models.find((m) => m.id === preset.default_model);
    const vision = !!model?.vision;
    const tools = p.protocol !== 'longcat';
    p.status = 'ok'; p.status_message = null;
    p.capabilities = { chat: true, json: true, tools, vision, stream: true, context_k: model?.context_k ?? 64 };
    steps.push(
      { id: 'connect', ok: true, message: null },
      { id: 'models', ok: true, message: `默认用 ${model?.name ?? p.models[0]}` },
      { id: 'json', ok: true, message: null },
      { id: 'tools', ok: tools, message: tools ? null : '不支持工具调用，助手改用 JSON 意图，功能不受影响' },
      { id: 'vision', ok: vision, message: vision ? null : '图里的文字仍会识别，示意图和流程图不会被理解' },
    );
    const bind = { connection_id: p.id, model: preset?.default_model ?? p.models[0]! };
    const roles = user.models.roles;
    if (!roles.chat && !roles.organize && !roles.generate) user.models.roles = { chat: bind, organize: bind, generate: bind, vision: vision ? bind : roles.vision };
    if (user.onboarding.ai !== 'done') user.onboarding.ai = 'done';
    const waiting = db.materials.filter((m) => m.user_id === user.id && m.status === 'waiting_ai');
    for (const courseId of new Set(waiting.map((m) => m.course_id))) {
      const ids = waiting.filter((m) => m.course_id === courseId).map((m) => m.id);
      for (const m of waiting.filter((x) => x.course_id === courseId)) m.status = 'reading';
      const job = newJob(user.id, 'ingest', courseId, courseId, { material_ids: ids, step: 0 });
      const course = byId('courses', courseId);
      if (course) course.organizing = { state: 'working', progress: 0, stage: '读取资料', job_id: job.id, attention: null };
    }
  }
  p.checked_at = nowIso();
  changed(user.id, ['providers', 'materials', 'courses']);
  return { connection: providerView(p), steps };
});
add('GET', '/me/models', ({ user }) => user.models);
add('PUT', '/me/models', ({ user, body }) => { user.models.roles = { ...user.models.roles, ...((body.roles ?? {}) as Partial<T.Models['roles']>) }; return user.models; });
add('GET', '/me/usage', ({ user, query }) => {
  const period = query.get('period') === 'month' ? 'month' : 'week';
  const from = addDays(today(), period === 'week' ? -6 : -29);
  const rows = db.usage.filter((u) => u.user_id === user.id && u.created_at.slice(0, 10) >= from);
  const tally = (list: typeof rows): T.Tally => ({ tokens_in: list.reduce((s, u) => s + u.tokens_in, 0), tokens_out: list.reduce((s, u) => s + u.tokens_out, 0), cost: +list.reduce((s, u) => s + (u.cost ?? 0), 0).toFixed(2) });
  const group = <K extends string>(key: (u: (typeof rows)[number]) => K | null) => {
    const map = new Map<K, typeof rows>();
    for (const u of rows) { const k = key(u); if (k === null) continue; map.set(k, [...(map.get(k) ?? []), u]); }
    return [...map];
  };
  const daily: { date: string; tokens: number }[] = [];
  for (let d = from; d <= today(); d = addDays(d, 1)) daily.push({ date: d, tokens: rows.filter((u) => u.created_at.startsWith(d)).reduce((s, u) => s + u.tokens_in + u.tokens_out, 0) });
  return {
    period, from, to: today(), total: tally(rows),
    by_feature: group((u) => u.feature).map(([feature, list]) => ({ feature, ...tally(list) })).sort((a, b) => b.tokens_in + b.tokens_out - a.tokens_in - a.tokens_out),
    by_course: group((u) => u.course_id).map(([course_id, list]) => ({ course_id, name: byId('courses', course_id)?.name ?? '已删除的课程', ...tally(list) })),
    by_plugin: group((u) => u.plugin_id).map(([plugin_id, list]) => ({ plugin_id, name: PLUGINS.find((p) => p.id === plugin_id)?.name ?? plugin_id, ...tally(list) })),
    daily,
    recent: [...rows].sort((a, b) => b.tokens_in + b.tokens_out - a.tokens_in - a.tokens_out).slice(0, 5).map((u) => ({ id: u.id, label: u.label, course_name: u.course_id ? byId('courses', u.course_id)?.name ?? null : null, tokens: u.tokens_in + u.tokens_out, cost: u.cost, created_at: u.created_at })),
  } satisfies T.Usage;
});
add('GET', '/me/limits', ({ user }) => ({ ...user.limits, today_tokens: db.usage.filter((u) => u.user_id === user.id && u.created_at.startsWith(today())).reduce((s, u) => s + u.tokens_in + u.tokens_out, 0) }));
add('PUT', '/me/limits', ({ user, body }) => {
  if (typeof body.confirm_tokens === 'number') user.limits.confirm_tokens = body.confirm_tokens;
  if ('daily_tokens' in body) user.limits.daily_tokens = (body.daily_tokens as number | null) ?? null;
  return { ...user.limits, today_tokens: 0 };
});
add('POST', '/estimate', ({ body }) => {
  const count = Number(body.count ?? 5);
  const tokens = body.op === 'ingest' ? 110_000 * ((body.material_ids as unknown[] | undefined)?.length ?? 1) : count * 2_800;
  return { tokens_min: Math.round(tokens * 0.8), tokens_max: Math.round(tokens * 1.2), cost_min: +(tokens * 0.8 * 4e-6).toFixed(2), cost_max: +(tokens * 1.2 * 4e-6).toFixed(2), needs_confirm: tokens > 20_000 };
});

// —— 今天与日程 ——
add('GET', '/today', ({ user }) => todayView(user));
add('PATCH', '/today', ({ user, body }) => {
  const minutes = Math.max(15, Math.min(600, Number(body.minutes)));
  const before = user.today_minutes?.date === today() ? user.today_minutes.minutes : user.settings.daily_minutes;
  const undo = withUndo(user, `今天改为 ${minutes} 分钟`, `今天可用时间改回 ${before} 分钟`, ['today', 'schedule'], (t) => {
    t.before('users', user);
    user.today_minutes = { date: today(), minutes };
    replanTracked(user, t);
  });
  return change(todayView(user), ['today', 'schedule'], undo);
});
add('PATCH', '/tasks/{id}', ({ user, params, body }) => {
  const task = db.tasks.find((t) => t.id === params[0] && t.user_id === user.id);
  if (!task) throw new ApiErr(404, 'not_found', '任务不存在');
  const label = body.status === 'done' ? '已完成' : body.status === 'skipped' ? '已跳过' : body.status === 'todo' ? '已恢复' : typeof body.date === 'string' ? `已挪到${relative(body.date)}` : '已更新';
  const undo = withUndo(user, label, '任务恢复原样', ['today', 'schedule'], (t) => {
    t.before('tasks', task);
    if (typeof body.status === 'string') task.status = body.status as T.Task['status'];
    if (typeof body.date === 'string') { task.date = body.date; task.pinned = true; }
    if (typeof body.pinned === 'boolean') task.pinned = body.pinned;
  });
  return change(taskView(task), ['today', 'schedule', 'course'], undo);
});
add('GET', '/schedule', ({ user, query }) => scheduleView(user, query.get('from') ?? undefined, query.get('to') ?? undefined));
add('PATCH', '/schedule/days/{date}', ({ user, params, body }) => {
  const date = params[0]!;
  const minutes = Math.max(0, Math.min(600, Number(body.minutes)));
  const undo = withUndo(user, `${relative(date)}改为 ${minutes} 分钟`, '可用时间改回原样', ['today', 'schedule'], (t) => {
    t.before('users', user);
    if (date === today()) user.today_minutes = { date, minutes };
    else user.day_minutes = { ...(user.day_minutes ?? {}), [date]: minutes };
    replanTracked(user, t);
  });
  return change(scheduleView(user, date, date).days[0]!, ['today', 'schedule'], undo);
});
add('POST', '/schedule/rebuild', ({ user }) => {
  const undo = withUndo(user, '已按现在的情况重排', '日程恢复原样', ['today', 'schedule'], (t) => replanTracked(user, t));
  return change(scheduleView(user), ['today', 'schedule'], undo);
});

// —— 课程与知识点 ——
add('GET', '/courses', ({ user }) => db.courses.filter((c) => c.user_id === user.id)
  .sort((a, b) => (a.exam_date ?? '9999') .localeCompare(b.exam_date ?? '9999') || a.created_at.localeCompare(b.created_at)).map(courseView));
add('POST', '/courses', ({ user, body }) => {
  writer(user);
  const name = str(body.name).trim();
  if (!name) throw new ApiErr(400, 'bad_request', '请填写课程名');
  const exam = typeof body.exam_date === 'string' && body.exam_date ? body.exam_date : null;
  const content = contentFor(name);
  const course: CourseRow = {
    id: uid('c'), user_id: user.id, name, color: typeof body.color === 'number' ? body.color : nextColor(user), exam_date: exam, sample: false,
    daily_cap_min: null, created_at: nowIso(), content: content.key,
    organizing: { state: 'idle', progress: null, stage: null, job_id: null, attention: null },
    format: { ...structuredClone(content.format), basis: 'default' }, ingested: false,
  };
  db.courses.push(course);
  db.threads.push({ id: uid('th'), user_id: user.id, course_id: course.id, title: name, kind: 'course', model: null, updated_at: nowIso(), preview: null });
  return courseView(course);
});
add('GET', '/courses/{id}', ({ user, params }) => courseView(courseOf(user, params[0]!)));
add('PATCH', '/courses/{id}', ({ user, params, body }) => {
  const course = courseOf(user, params[0]!);
  const undo = withUndo(user, '已修改课程', '课程设置恢复原样', ['courses', 'course', 'today', 'schedule'], (t) => {
    t.before('courses', course);
    if (typeof body.name === 'string' && body.name.trim()) course.name = body.name.trim();
    if ('exam_date' in body) course.exam_date = (body.exam_date as string | null) || null;
    if (typeof body.color === 'number') course.color = body.color;
    if ('daily_cap_min' in body) course.daily_cap_min = (body.daily_cap_min as number | null) ?? null;
  });
  planUser(user, true);
  return change(courseView(course), ['courses', 'course', 'today', 'schedule'], undo);
});
add('DELETE', '/courses/{id}', ({ user, params }) => {
  const course = courseOf(user, params[0]!);
  const kpIds = new Set(db.kps.filter((k) => k.course_id === course.id).map((k) => k.id));
  const sessionIds = new Set(db.sessions.filter((s) => s.course_id === course.id).map((s) => s.id));
  const materialIds = new Set(db.materials.filter((m) => m.course_id === course.id).map((m) => m.id));
  const threadIds = new Set(db.threads.filter((t) => t.course_id === course.id).map((t) => t.id));
  removeWhere('courses', (c) => c.id === course.id);
  for (const table of ['chapters', 'topics', 'kps', 'fragments', 'conflicts', 'bank', 'mistakes', 'tasks', 'readiness'] as const) removeWhere(table, (r) => (r as { course_id: T.ID }).course_id === course.id);
  removeWhere('materials', (m) => materialIds.has(m.id));
  removeWhere('pages', (p) => materialIds.has(p.material_id));
  removeWhere('sessions', (s) => sessionIds.has(s.id));
  removeWhere('items', (i) => sessionIds.has(i.session_id));
  removeWhere('events', (e) => kpIds.has(e.kp_id));
  removeWhere('threads', (t) => threadIds.has(t.id));
  removeWhere('messages', (m) => threadIds.has(m.thread_id));
  planUser(user, true);
  changed(user.id, ['courses', 'today', 'schedule', 'practice', 'threads']);
});
add('GET', '/courses/{id}/home', ({ user, params }) => {
  const course = courseOf(user, params[0]!);
  const states = kpStates(course.id);
  planUser(user);
  const last = db.sessions.filter((s) => s.course_id === course.id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return {
    course: courseView(course), map: mapView(course.id, states),
    next: db.tasks.filter((t) => t.user_id === user.id && t.course_id === course.id && t.date === today() && t.status === 'todo').map(taskView),
    weak: weakKps(course.id, 3, states), last_session: last ? summaryView(last) : null,
  } satisfies T.CourseHome;
});
add('GET', '/courses/{id}/map', ({ user, params }) => mapView(courseOf(user, params[0]!).id));
add('GET', '/kps/{id}', ({ user, params, query }) => {
  const kp = ownKp(params[0]!, user);
  const states = kpStates(kp.course_id);
  const taskId = query.get('task_id');
  const task = taskId ? db.tasks.find((t) => t.id === taskId && t.user_id === user.id) : undefined;
  const ordered = db.kps.filter((k) => k.course_id === kp.course_id).sort((a, b) => a.order - b.order);
  const sequence = task?.kp_ids.length ? task.kp_ids : ordered.map((k) => k.id);
  const at = sequence.indexOf(kp.id);
  const quiz = kpQuizSession(user, kp);
  const teacher = db.fragments.filter((f) => f.course_id === kp.course_id && f.kps.some((k) => k.id === kp.id && (k.user_choice ?? k.certainty === 'sure'))).map((f) => ({ text: f.text, fragment_id: f.id }));
  return {
    id: kp.id, course_id: kp.course_id, title: kp.title,
    chapter: { id: kp.chapter_id, title: byId('chapters', kp.chapter_id)?.title ?? '' },
    topic: { id: kp.topic_id, title: byId('topics', kp.topic_id)?.title ?? '' },
    state: states.get(kp.id) ?? 'new', level: kp.level, modes: kp.modes, types: questionTypesFor(kp), teacher,
    sections: explainFor(kp).map((blocks, i) => ({ blocks, refs: i === 0 ? kp.refs.slice(0, 1).map((r) => refView(r, kp.summary.split(/[，；]/u)[0] ?? null)) : [] })),
    pages: kp.refs.map((r) => refView(r, kp.summary.split(/[，；]/u)[0] ?? null)),
    quiz: db.items.filter((i) => i.session_id === quiz.id).sort((a, b) => a.index - b.index).map(questionView),
    map: chapterView(kp.chapter_id, states),
    prev_id: at > 0 ? sequence[at - 1]! : null, next_id: at >= 0 && at < sequence.length - 1 ? sequence[at + 1]! : null,
    task: task ? { id: task.id, index: Math.max(0, task.kp_ids.indexOf(kp.id)) + 1, total: task.kp_ids.length } : null,
    understood_at: kp.understood_at,
  } satisfies T.KpDetail;
});
add('POST', '/kps/{id}/understood', ({ user, params, body }) => {
  const kp = ownKp(params[0]!, user);
  const task = typeof body.task_id === 'string' ? db.tasks.find((t) => t.id === body.task_id && t.user_id === user.id) : undefined;
  const undo = withUndo(user, '已标记懂了', '恢复为未学', ['map', 'today', 'course', 'kp'], (t) => {
    t.before('kps', kp);
    if (task) t.before('tasks', task);
    kp.understood_at ??= nowIso();
    if (task && task.kp_ids.every((id) => byId('kps', id)?.understood_at)) task.status = 'done';
  });
  const pool = task?.kp_ids.length ? task.kp_ids.map((id) => byId('kps', id)!).filter(Boolean) : db.kps.filter((k) => k.topic_id === kp.topic_id).sort((a, b) => a.order - b.order);
  const next = pool.find((k) => !k.understood_at && k.id !== kp.id) ?? null;
  changed(user.id, ['map', 'course', 'today'], kp.course_id);
  return change({ kp: kpBrief(kp), next_kp_id: next?.id ?? null, task: task ? taskView(task) : null }, ['map', 'today', 'course', 'kp'], undo);
});
add('POST', '/kps/{id}/mark', ({ user, params, body }) => {
  const kp = ownKp(params[0]!, user);
  const undo = withUndo(user, body.mark === 'mastered' ? '已标记为已掌握' : body.mark === 'shaky' ? '已标记为还不熟' : '已取消标记', '恢复原来的标记', ['map', 'kp', 'course'], (t) => {
    t.before('kps', kp);
    kp.mark = (body.mark as KpRow['mark']) ?? null;
  });
  return change(kpBrief(kp), ['map', 'kp', 'course', 'today'], undo);
});

// —— 资料 ——
const ALLOWED = /\.(pdf|pptx?|docx?|txt|md|png|jpe?g|heic)$/i;
add('GET', '/courses/{id}/materials', ({ user, params }) => db.materials.filter((m) => m.course_id === courseOf(user, params[0]!).id).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).map(materialView));
add('POST', '/courses/{id}/materials', ({ user, params, form }) => {
  writer(user);
  const course = courseOf(user, params[0]!);
  const files = (form?.getAll('files') ?? []).filter((f): f is File => typeof f !== 'string');
  if (!files.length) throw new ApiErr(400, 'bad_request', '没有收到文件');
  if (files.length > 20) throw new ApiErr(400, 'bad_request', '一次最多上传 20 份');
  for (const f of files) {
    if (!ALLOWED.test(f.name)) throw new ApiErr(415, 'unsupported_type', `不支持这种格式：${f.name}`);
    if (f.size > 50 * 1024 * 1024) throw new ApiErr(413, 'too_large', `${f.name} 超过 50 MB`);
  }
  const ai = hasAi(user) || course.sample;
  const source = form?.get('source') === 'photo' ? 'photo' : 'file';
  const rows = files.map((f) => addMaterial(user, course, f.name, source === 'photo' || /\.(png|jpe?g|heic)$/i.test(f.name) ? 'photo' : 'other', ai ? 'reading' : 'waiting_ai', null));
  if (!ai) {
    course.organizing = { state: 'waiting_ai', progress: null, stage: '等待连接 AI 后整理', job_id: null, attention: null };
    return { materials: rows.map(materialView), job: null };
  }
  const job = newJob(user.id, 'ingest', course.id, course.id, { material_ids: rows.map((m) => m.id), step: 0 }, 500);
  course.organizing = { state: 'working', progress: 0, stage: '读取资料', job_id: job.id, attention: null };
  return { materials: rows.map(materialView), job: jobView(job) };
});
add('PATCH', '/materials/{id}', ({ user, params, body }) => {
  const m = own('materials', params[0]!, user, '资料');
  const undo = withUndo(user, '已修改资料类型', '恢复原来的类型', ['materials'], (t) => { t.before('materials', m); m.kind = body.kind as T.MaterialKind; });
  return change(materialView(m), ['materials', 'map'], undo);
});
add('POST', '/materials/{id}/decision', ({ user, params, body }) => {
  const m = own('materials', params[0]!, user, '资料');
  if (!m.decision) throw new ApiErr(409, 'conflict', '这份资料没有需要确认的判断');
  const choice = str(body.choice);
  const older = db.materials.find((x) => x.superseded_by === m.id || (m.superseded_by === x.id));
  const undo = withUndo(user, '已改正判断', '恢复原来的判断', ['materials', 'map'], (t) => {
    t.before('materials', m);
    if (older) t.before('materials', older);
    m.decision = { ...m.decision!, choice };
    if (m.decision.kind === 'version' && older) {
      if (choice === 'old') { m.superseded_by = older.id; older.superseded_by = null; }
      else if (choice === 'both') { m.superseded_by = null; older.superseded_by = null; }
      else { m.superseded_by = null; older.superseded_by = m.id; }
    }
    if (m.decision.kind === 'role') m.kind = choice === 'slides' ? 'slides' : /往年|真题|试卷/.test(m.title) ? 'past_paper' : 'review';
  });
  return change(materialView(m), ['materials', 'map', 'course'], undo);
});
add('DELETE', '/materials/{id}', ({ user, params }) => {
  const m = own('materials', params[0]!, user, '资料');
  removeWhere('materials', (x) => x.id === m.id);
  removeWhere('pages', (p) => p.material_id === m.id);
  for (const x of db.materials.filter((y) => y.superseded_by === m.id)) x.superseded_by = null;
  const orphan = new Set(db.kps.filter((k) => k.course_id === m.course_id && k.refs.length && k.refs.every((r) => r.material_id === m.id)).map((k) => k.id));
  removeWhere('kps', (k) => orphan.has(k.id));
  removeWhere('bank', (b) => orphan.has(b.kp_id));
  removeWhere('events', (e) => orphan.has(e.kp_id));
  for (const kp of db.kps) kp.refs = kp.refs.filter((r) => r.material_id !== m.id);
  for (const ch of db.chapters.filter((c) => c.course_id === m.course_id)) if (!db.kps.some((k) => k.chapter_id === ch.id)) removeWhere('chapters', (c) => c.id === ch.id);
  planUser(user, true);
  changed(user.id, ['materials', 'map', 'course', 'courses', 'today'], m.course_id);
});
add('GET', '/materials/{id}/pages', ({ user, params }) => {
  const m = own('materials', params[0]!, user, '资料');
  return { pages: db.pages.filter((p) => p.material_id === m.id).sort((a, b) => a.page - b.page).map((p) => ({ page: p.page, title: p.title, thumb_url: null })) };
});
add('GET', '/materials/{id}/pages/{n}', ({ user, params }) => {
  const m = own('materials', params[0]!, user, '资料');
  const page = pageView(m.id, Number(params[1]));
  if (!page) throw new ApiErr(404, 'not_found', '这一页不存在');
  return page;
});
add('POST', '/courses/{id}/photo-link', ({ user, params }) => ({ url: `fullgrid://photo?course=${courseOf(user, params[0]!).id}&t=${uid('pl')}`, expires_at: new Date(Date.now() + 600_000).toISOString() }));

// —— 老师重点与考试形式 ——
add('GET', '/courses/{id}/focus', ({ user, params }) => focusView(courseOf(user, params[0]!)));
add('POST', '/courses/{id}/focus/fragments', ({ user, params, body }) => {
  const course = courseOf(user, params[0]!);
  const value = str(body.text).trim();
  if (!value) throw new ApiErr(400, 'bad_request', '请粘贴老师说的话');
  if (!course.sample) { if (user.guest) writer(user); }
  for (const part of value.split(/(?<=[。！？!?；;\n])/u).map((s) => s.trim()).filter((s) => s.length > 1)) {
    db.fragments.push({ id: uid('fr'), course_id: course.id, text: part, found: false, created_at: nowIso(), analyzed: false, kps: [] });
  }
  if (course.ingested) newJob(user.id, 'focus', course.id, course.id, {}, 1400);
  return focusView(course);
});
add('DELETE', '/focus/fragments/{id}', ({ user, params }) => {
  const fr = db.fragments.find((f) => f.id === params[0]);
  const course = fr && courseOf(user, fr.course_id);
  if (!fr || !course) throw new ApiErr(404, 'not_found', '这句话不存在');
  const undo = withUndo(user, '已删除这句原话', '恢复这句原话', ['focus', 'map', 'today'], (t) => {
    t.before('fragments', fr);
    for (const kp of db.kps.filter((k) => k.course_id === course.id)) t.before('kps', kp);
    removeWhere('fragments', (f) => f.id === fr.id);
    recomputeLevels(course.id);
  });
  planUser(user, true);
  return change(focusView(course), ['focus', 'map', 'course', 'today'], undo);
});
add('POST', '/courses/{id}/focus/kps', ({ user, params, body }) => {
  const course = courseOf(user, params[0]!);
  const kpId = str(body.kp_id);
  const include = body.include as boolean | null;
  const undo = withUndo(user, include === false ? '已移除' : include ? '已选入' : '已恢复', '恢复原来的选择', ['focus', 'map'], (t) => {
    for (const fr of db.fragments.filter((f) => f.course_id === course.id && f.kps.some((k) => k.id === kpId))) {
      t.before('fragments', fr);
      for (const k of fr.kps) if (k.id === kpId) k.user_choice = include;
    }
    for (const kp of db.kps.filter((k) => k.course_id === course.id)) t.before('kps', kp);
    recomputeLevels(course.id);
  });
  return change(focusView(course), ['focus', 'map', 'course', 'today'], undo);
});
add('POST', '/focus/conflicts/{id}', ({ user, params, body }) => {
  const conflict = db.conflicts.find((c) => c.id === params[0]);
  const course = conflict && courseOf(user, conflict.course_id);
  if (!conflict || !course) throw new ApiErr(404, 'not_found', '不存在');
  const undo = withUndo(user, '已选定', '恢复为待确认', ['focus', 'map'], (t) => {
    t.before('conflicts', conflict);
    for (const kp of db.kps.filter((k) => k.course_id === course.id)) t.before('kps', kp);
    conflict.choice = body.choice as 'excluded' | 'emphasized';
    recomputeLevels(course.id);
  });
  return change(focusView(course), ['focus', 'map', 'course'], undo);
});
add('GET', '/courses/{id}/exam-format', ({ user, params }) => courseOf(user, params[0]!).format);
add('PUT', '/courses/{id}/exam-format', ({ user, params, body }) => {
  const course = courseOf(user, params[0]!);
  const undo = withUndo(user, '已修改考试形式', '考试形式恢复原样', ['focus', 'practice'], (t) => {
    t.before('courses', course);
    course.format = { types: body.types as T.ExamFormat['types'], duration_min: (body.duration_min as number | null) ?? null, open_book: (body.open_book as boolean | null) ?? null, basis: 'user' };
  });
  return change(course.format, ['focus', 'practice'], undo);
});

// —— 练习 ——
add('GET', '/practice', ({ user, query }) => practiceHub(user, query.get('course_id')));
add('POST', '/sessions', ({ user, body }) => sessionView(createSession(user, body as unknown as T.NewSession)));
add('GET', '/sessions/{id}', ({ user, params }) => sessionView(own('sessions', params[0]!, user, '练习')));
add('PATCH', '/sessions/{id}', ({ user, params, body }) => { own('sessions', params[0]!, user, '练习').position = Number(body.position ?? 0); });
add('POST', '/sessions/{id}/finish', ({ user, params }) => {
  const s = own('sessions', params[0]!, user, '练习');
  const result = finish(user, s);
  if (user.resume?.href === `/session/${s.id}`) user.resume = null;
  planUser(user, true);
  changed(user.id, ['today', 'map', 'course', 'courses', 'practice', 'mistakes', 'insight', 'schedule'], s.course_id);
  return { ...result, session: sessionView(s) };
});
add('GET', '/sessions/{id}/result', ({ user, params }) => {
  const s = own('sessions', params[0]!, user, '练习');
  if (!s.result) throw new ApiErr(409, 'conflict', '这次练习还没有完成');
  return { ...s.result, session: sessionView(s) };
});
add('DELETE', '/sessions/{id}', ({ user, params }) => {
  const s = own('sessions', params[0]!, user, '练习');
  removeWhere('sessions', (x) => x.id === s.id);
  removeWhere('items', (i) => i.session_id === s.id);
  removeWhere('events', (e) => e.session_id === s.id);
  changed(user.id, ['practice', 'map', 'course', 'today'], s.course_id);
});
add('POST', '/questions/{id}/attempt', ({ user, params, body }) => {
  const r = attempt(user, params[0]!, (body.response as string | null) ?? null);
  if (r.mastery.length) changed(user.id, ['map', 'course', 'courses'], r.question.course_id);
  return r;
});
add('POST', '/questions/{id}/grade', ({ user, params, body }) => {
  const r = grade(user, params[0]!, (body.marks ?? {}) as Record<string, T.Mark>);
  if (r.mastery.length) changed(user.id, ['map', 'course', 'courses'], r.question.course_id);
  return r;
});
add('POST', '/questions/{id}/hint', ({ user, params, body }) => hint(user, params[0]!, (Number(body.level) || 1) as 1 | 2 | 3));
add('POST', '/questions/{id}/report', ({ user, params }) => report(user, params[0]!));
add('GET', '/mistakes', ({ user, query }) => mistakesView(user, query.get('course_id')));
add('DELETE', '/mistakes/{id}', ({ user, params }) => {
  const m = db.mistakes.find((x) => x.user_id === user.id && x.bank_id === params[0]);
  if (!m) throw new ApiErr(404, 'not_found', '错题不存在');
  const undo = withUndo(user, '已移出错题本', '放回错题本', ['mistakes', 'practice'], (t) => { t.before('mistakes', m); m.removed = true; });
  return change(null, ['mistakes', 'practice'], undo);
});
add('POST', '/mistakes/{id}/similar', ({ user, params }) => sessionView(similarSession(user, params[0]!)));

// —— 学情 ——
add('GET', '/courses/{id}/insight', ({ user, params }) => insightView(courseOf(user, params[0]!)));

// —— 助手 ——
const threadView = ({ user_id: _u, ...t }: (typeof db.threads)[number]): T.Thread => t;
const stopped = new Set<T.ID>();
add('GET', '/threads', ({ user }) => db.threads.filter((t) => t.user_id === user.id).sort((a, b) => Number(b.kind === 'global') - Number(a.kind === 'global') || b.updated_at.localeCompare(a.updated_at)).map(threadView));
add('POST', '/threads', ({ user, body }) => {
  const row = { id: uid('th'), user_id: user.id, course_id: (body.course_id as T.ID | null) ?? null, title: str(body.title) || '新对话', kind: 'custom' as const, model: null, updated_at: nowIso(), preview: null };
  db.threads.push(row);
  return threadView(row);
});
add('PATCH', '/threads/{id}', ({ user, params, body }) => {
  const t = own('threads', params[0]!, user, '对话');
  if (typeof body.title === 'string') t.title = body.title;
  if ('model' in body) t.model = (body.model as string | null) ?? null;
  return threadView(t);
});
add('DELETE', '/threads/{id}', ({ user, params }) => {
  const t = own('threads', params[0]!, user, '对话');
  if (t.kind !== 'custom') throw new ApiErr(409, 'conflict', '课程和全局对话不能删除，可以清空');
  removeWhere('threads', (x) => x.id === t.id);
  removeWhere('messages', (m) => m.thread_id === t.id);
});
add('GET', '/threads/{id}', ({ user, params }) => {
  const t = own('threads', params[0]!, user, '对话');
  return { thread: threadView(t), messages: db.messages.filter((m) => m.thread_id === t.id).slice(-50).map(({ thread_id: _t, ...m }) => m) };
});
add('POST', '/threads/{id}/messages', ({ user, params, body }) => {
  const t = own('threads', params[0]!, user, '对话');
  stopped.delete(t.id);
  const events = respond({ user, thread: t, textIn: str(body.text), context: (body.context ?? { route: '/' }) as T.ChatContext, command: body.command as T.Command | undefined });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let replyId: T.ID | null = null;
      try {
        for await (const event of events) {
          if (event.type === 'start') replyId = event.message_id;
          if (stopped.has(t.id)) {
            const reply = db.messages.find((m) => m.id === replyId);
            if (reply) reply.status = 'stopped';
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'done' })}\n`));
            break;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', code: 'internal', message: '助手处理时出错，可以重试', retryable: true })}\n`));
      }
      const reply = db.messages.find((m) => m.id === replyId);
      if (reply) t.preview = reply.text.slice(0, 40) || null;
      persist();
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
});
add('POST', '/threads/{id}/stop', ({ user, params }) => { stopped.add(own('threads', params[0]!, user, '对话').id); });
add('POST', '/proposals/{id}', ({ user, params, body }) => {
  const message = db.messages.find((m) => m.cards.some((c) => c.id === params[0]));
  const card = message?.cards.find((c) => c.id === params[0]);
  const thread = message && byId('threads', message.thread_id);
  if (!card || card.kind !== 'proposal' || !thread || thread.user_id !== user.id) throw new ApiErr(404, 'not_found', '提议不存在');
  if (card.state !== 'pending') throw new ApiErr(409, 'conflict', '这个提议已经处理过了');
  const course = thread.course_id ? byId('courses', thread.course_id) : undefined;
  if (body.accept) {
    if (card.title.startsWith('删除') && course) {
      const m = db.materials.find((x) => x.course_id === course.id && card.title.includes(x.title));
      if (m) { removeWhere('materials', (x) => x.id === m.id); removeWhere('pages', (p) => p.material_id === m.id); }
    } else if (course) {
      const names: Record<string, T.QuestionType> = { 单选题: 'single', 填空题: 'fill', 计算题: 'calc', 简答题: 'short', 证明题: 'proof', 设计题: 'design' };
      for (const row of card.changes) {
        const type = names[row.label];
        if (type) { const entry = course.format.types.find((x) => x.type === type); if (entry) entry.count = Number.parseInt(row.to, 10); }
        if (row.label === '开闭卷') course.format.open_book = row.to === '开卷';
      }
      course.format.basis = 'user';
    }
  }
  card.state = body.accept ? 'accepted' : 'declined';
  changed(user.id, card.affects, course?.id ?? null);
  return { card, affects: card.affects };
});
add('POST', '/agent-tasks/{id}/stop', ({ user, params }) => {
  const job = db.jobs.find((j) => j.id === params[0] && j.user_id === user.id);
  if (job) { job.status = 'failed'; job.error = { message: '已停止', retryable: true }; }
});

// —— 通知 ——
add('GET', '/notifications', ({ user }) => {
  const items = db.notifications.filter((n) => n.user_id === user.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50).map(({ user_id: _u, ...n }) => n);
  return { items, unread: items.filter((n) => !n.read).length };
});
add('POST', '/notifications/read', ({ user, body }) => {
  const ids = body.ids as T.ID[] | undefined;
  for (const n of db.notifications) if (n.user_id === user.id && (!ids || ids.includes(n.id))) n.read = true;
  return { unread: db.notifications.filter((n) => n.user_id === user.id && !n.read).length };
});

// —— 插件 ——
function pluginView(user: UserRow, id: T.ID): T.PluginDetail {
  const catalog = PLUGINS.find((p) => p.id === id);
  const row = db.plugins.find((p) => p.user_id === user.id && p.id === id);
  if (!catalog || !row) throw new ApiErr(404, 'not_found', '插件不存在');
  const { default: _d, ...rest } = catalog;
  return { ...rest, installed: row.installed, enabled: row.enabled, scope: row.scope, course_ids: row.course_ids, granted: row.granted, usage_tokens: db.usage.filter((u) => u.user_id === user.id && u.plugin_id === id).reduce((s, u) => s + u.tokens_in + u.tokens_out, 0) };
}
add('GET', '/plugins', ({ user }) => PLUGINS.map((p) => { const { readme: _r, ...view } = pluginView(user, p.id); return view; }));
add('GET', '/plugins/{id}', ({ user, params }) => pluginView(user, params[0]!));
add('POST', '/plugins', ({ user }) => { writer(user); throw new ApiErr(409, 'conflict', '演示环境不能从链接安装插件，可以先试试内置插件'); });
add('POST', '/plugins/{id}/install', ({ user, params }) => {
  const row = db.plugins.find((p) => p.user_id === user.id && p.id === params[0]);
  if (!row) throw new ApiErr(404, 'not_found', '插件不存在');
  Object.assign(row, { installed: true, enabled: true, granted: true });
  return pluginView(user, row.id);
});
add('PATCH', '/plugins/{id}', ({ user, params, body }) => {
  const row = db.plugins.find((p) => p.user_id === user.id && p.id === params[0]);
  if (!row) throw new ApiErr(404, 'not_found', '插件不存在');
  if (typeof body.enabled === 'boolean') row.enabled = body.enabled;
  if (body.scope === 'all' || body.scope === 'courses') row.scope = body.scope;
  if (Array.isArray(body.course_ids)) row.course_ids = body.course_ids as T.ID[];
  return pluginView(user, row.id);
});
add('DELETE', '/plugins/{id}', ({ params }) => { if (PLUGINS.some((p) => p.id === params[0])) throw new ApiErr(409, 'conflict', '内置插件只能停用'); });

add('POST', '/speech/transcribe', () => { throw new ApiErr(409, 'conflict', '语音转文字这一版还没有启用'); });

// —— 入口 ——
export async function mockFetch(request: Request): Promise<Response> {
  const url = new URL(request.url, 'http://mock.local');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  if (mockConfig.latency) await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
  const route = routes.find((r) => r.method === request.method && r.pattern.test(path));
  if (!route) return errorResponse(new ApiErr(404, 'not_found', '接口不存在'));
  const params = (path.match(route.pattern) ?? []).slice(1).map(decodeURIComponent);
  const auth = request.headers.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : url.searchParams.get('access_token');
  const tokenRow = token ? db.tokens.find((t) => t.token === token && t.kind === 'access') : undefined;
  const user = tokenRow ? byId('users', tokenRow.user_id) : undefined;
  if (!route.open && !user) return errorResponse(new ApiErr(401, 'unauthorized', '请先登录'));
  let body: Body = {};
  let form: FormData | null = null;
  const type = request.headers.get('Content-Type') ?? '';
  try {
    if (type.includes('application/json')) body = (await request.json()) as Body;
    else if (request.method === 'POST' && request.body) form = await request.formData();
  } catch {
    return errorResponse(new ApiErr(400, 'bad_request', '请求体格式不对'));
  }
  try {
    const result = await route.handler({ user: user!, body, params, query: url.searchParams, form, token, deviceId: tokenRow?.device_id ?? null });
    persist();
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return json(result);
  } catch (e) {
    if (e instanceof ApiErr) return errorResponse(e);
    console.error('[mock]', request.method, path, e);
    return errorResponse(new ApiErr(500, 'internal', '演示后端处理时出错，请重试'));
  }
}

export function resetMock() {
  resetDb();
}

export { analyzeFragments, mapView, kpStates };
