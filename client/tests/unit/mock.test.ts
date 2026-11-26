// 演示后端按 api-v1.md 的形状工作：主流程端到端走一遍（不经过界面）。
import { beforeEach, describe, expect, it } from 'vitest';
import type * as T from '../../src/api/types';
import { mockConfig } from '../../src/mock/config';
import { resetDb } from '../../src/mock/db';
import { tick } from '../../src/mock/jobs';
import { mockFetch } from '../../src/mock/server';

mockConfig.latency = false;
mockConfig.speed = 0;

const device = { kind: 'browser', name: '测试浏览器', timezone: 'Asia/Shanghai' };

async function call<R = any>(method: string, path: string, body?: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  const res = await mockFetch(new Request(`http://test/api/v1${path}`, { method, headers, body: payload }));
  const text = await res.text();
  const type = res.headers.get('Content-Type') ?? '';
  const data = type.includes('ndjson') ? text.trim().split('\n').map((l) => JSON.parse(l)) : text ? JSON.parse(text) : null;
  return { status: res.status, data: data as R };
}

function settle(session: T.Session) {
  tick(Date.now() + 60_000);
  tick(Date.now() + 120_000);
  return session.id;
}

describe('演示后端', () => {
  beforeEach(() => resetDb());

  it('访客：今天、课程主页、知识点“懂了”', async () => {
    const { data: tokens } = await call<T.Tokens>('POST', '/auth/guest', { device });
    const t = tokens.access_token;
    const today = await call<T.Today>('GET', '/today', undefined, t);
    expect(today.status).toBe(200);
    expect(today.data.tasks.length).toBeGreaterThan(0);
    const courses = await call<T.Course[]>('GET', '/courses', undefined, t);
    expect(courses.data).toHaveLength(1);
    expect(courses.data[0]!.sample).toBe(true);
    const home = await call<T.CourseHome>('GET', `/courses/${courses.data[0]!.id}/home`, undefined, t);
    expect(home.data.map.chapters.length).toBe(3);
    const banker = home.data.map.chapters.flatMap((c) => c.kps).find((k) => k.title === '银行家算法')!;
    expect(banker.level).toBe('emphasized');
    const kp = await call<T.KpDetail>('GET', `/kps/${banker.id}`, undefined, t);
    expect(kp.data.teacher[0]?.text).toContain('银行家');
    expect(kp.data.quiz.length).toBeGreaterThan(0);
    const understood = await call<T.Change<{ kp: T.KpBrief }>>('POST', `/kps/${banker.id}/understood`, {}, t);
    expect(understood.data.result.kp.state).toBe('learned');
    expect(understood.data.undo).not.toBeNull();
    const blocked = await call('POST', '/courses', { name: '离散数学' }, t);
    expect(blocked.status).toBe(403);
  });

  it('快练：先出后核，作答判分，完成后有结果', async () => {
    const { data: tokens } = await call<T.Tokens>('POST', '/auth/guest', { device });
    const t = tokens.access_token;
    const course = (await call<T.Course[]>('GET', '/courses', undefined, t)).data[0]!;
    const created = await call<T.Session>('POST', '/sessions', { kind: 'quick', course_id: course.id }, t);
    expect(created.status).toBe(200);
    expect(created.data.questions.every((q) => q.status === 'pending')).toBe(true);
    const sid = settle(created.data);
    const session = (await call<T.Session>('GET', `/sessions/${sid}`, undefined, t)).data;
    expect(session.status).toBe('active');
    const single = session.questions.find((q) => q.type === 'single')!;
    expect(single.check).toBe('passed');
    const hint = await call<{ hint: T.Hint }>('POST', `/questions/${single.id}/hint`, { level: 1 }, t);
    expect(hint.data.hint.text.length).toBeGreaterThan(4);
    const answer = await call<T.AttemptResult>('POST', `/questions/${single.id}/attempt`, { response: 'A' }, t);
    expect(answer.data.question.attempt?.state).toBe('graded');
    expect(answer.data.question.solution).not.toBeNull();
    const again = await call('POST', `/questions/${single.id}/attempt`, { response: 'B' }, t);
    expect(again.status).toBe(409);
    const result = await call<T.Result>('POST', `/sessions/${sid}/finish`, {}, t);
    expect(result.data.total).toBeGreaterThan(0);
    expect(result.data.session.status).toBe('finished');
  });

  it('演示账号：三门课、顺延提示、错题、学情、用量', async () => {
    await call('POST', '/auth/sms', { phone: '13800000000' });
    const wrong = await call('POST', '/auth/login', { phone: '13800000000', code: '000000', device });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error.message).toContain('还可以试');
    const { data: tokens } = await call<T.Tokens>('POST', '/auth/login', { phone: '13800000000', code: '123456', device });
    const t = tokens.access_token;
    const courses = (await call<T.Course[]>('GET', '/courses', undefined, t)).data;
    expect(courses.map((c) => c.name)).toEqual(['高等数学', '操作系统', '数据结构']);
    const today = (await call<T.Today>('GET', '/today', undefined, t)).data;
    expect(today.notice).toContain('没做完');
    expect(today.tasks.some((x) => x.moved_from)).toBe(true);
    expect(today.countdowns[0]!.urgent).toBe(true);
    const mistakes = (await call<T.Mistake[]>('GET', '/mistakes', undefined, t)).data;
    expect(mistakes.length).toBeGreaterThan(0);
    const insight = (await call<T.Insight>('GET', `/courses/${courses[0]!.id}/insight`, undefined, t)).data;
    expect(insight.verdict.length).toBeGreaterThan(5);
    const usage = (await call<T.Usage>('GET', '/me/usage?period=week', undefined, t)).data;
    expect(usage.total.tokens_in).toBeGreaterThan(0);
    const mock = await call('POST', '/sessions', { kind: 'mock', course_id: courses[1]!.id }, t);
    expect(mock.status).toBe(409);
    expect(mock.data.error.code).toBe('needs_confirmation');
    const confirmed = await call<T.Session>('POST', '/sessions', { kind: 'mock', course_id: courses[1]!.id, confirm: true }, t);
    expect(confirmed.data.questions.length).toBeGreaterThan(10);
  });

  it('撤销：勾掉任务后撤销恢复', async () => {
    const { data: tokens } = await call<T.Tokens>('POST', '/auth/guest', { device });
    const t = tokens.access_token;
    const task = (await call<T.Today>('GET', '/today', undefined, t)).data.tasks[0]!;
    const done = await call<T.Change<T.Task>>('PATCH', `/tasks/${task.id}`, { status: 'done' }, t);
    expect(done.data.result.status).toBe('done');
    await call('POST', `/undo/${done.data.undo!.id}`, {}, t);
    const after = (await call<T.Today>('GET', '/today', undefined, t)).data;
    expect(after.tasks.some((x) => x.id === task.id)).toBe(true);
    const twice = await call('POST', `/undo/${done.data.undo!.id}`, {}, t);
    expect(twice.status).toBe(409);
  });

  it('助手：今天只有 1 小时 → 改动卡，可以撤销', async () => {
    const { data: tokens } = await call<T.Tokens>('POST', '/auth/guest', { device });
    const t = tokens.access_token;
    const thread = (await call<T.Thread[]>('GET', '/threads', undefined, t)).data.find((x) => x.kind === 'global')!;
    const ids = (today: T.Today) => today.tasks.map((x) => x.id).sort().join();
    const original = ids((await call<T.Today>('GET', '/today', undefined, t)).data);
    const events = (await call<T.ChatEvent[]>('POST', `/threads/${thread.id}/messages`, { text: '今天只有 1 小时', context: { route: '/' } }, t)).data;
    const card = events.find((e) => e.type === 'card') as Extract<T.ChatEvent, { type: 'card' }>;
    expect(card.card.kind).toBe('change');
    expect(events.at(-1)!.type).toBe('done');
    const today = (await call<T.Today>('GET', '/today', undefined, t)).data;
    expect(today.minutes_available).toBe(60);
    if (card.card.kind === 'change') await call('POST', `/undo/${card.card.undo_id}`, {}, t);
    const restored = (await call<T.Today>('GET', '/today', undefined, t)).data;
    expect(restored.minutes_available).toBe(120);
    // 撤销后任务和改动前完全一样：重排新建的任务被删掉，被删的旧任务回来，不重复
    expect(ids(restored)).toBe(original);
  });

  it('新用户：没连 AI 时上传等待，连接后整理出知识结构', async () => {
    await call('POST', '/auth/sms', { phone: '13912345678' });
    const { data: tokens } = await call<T.Tokens>('POST', '/auth/login', { phone: '13912345678', code: '123456', device });
    expect(tokens.is_new).toBe(true);
    expect(tokens.user.onboarding.ai).toBeNull();
    const t = tokens.access_token;
    const course = (await call<T.Course>('POST', '/courses', { name: '数据结构', exam_date: null }, t)).data;
    const form = new FormData();
    form.append('files', new File(['x'], '数据结构 第一章.pptx'));
    form.append('source', 'file');
    const up = await call<{ materials: T.Material[]; job: T.Job | null }>('POST', `/courses/${course.id}/materials`, form, t);
    expect(up.data.materials[0]!.status).toBe('waiting_ai');
    expect(up.data.job).toBeNull();
    const chat = await call<T.ChatEvent[]>('POST', `/threads/${(await call<T.Thread[]>('GET', '/threads', undefined, t)).data.find((x) => x.course_id === course.id)!.id}/messages`, { text: '讲讲栈', context: { route: '/', course_id: course.id } }, t);
    expect(chat.data.some((e) => e.type === 'card' && e.card.kind === 'connect')).toBe(true);
    const conn = (await call<T.Connection>('POST', '/me/providers', { preset_id: 'deepseek', key: 'sk-test-1234567890' }, t)).data;
    const check = (await call<T.CheckResult>('POST', `/me/providers/${conn.id}/check`, {}, t)).data;
    expect(check.connection.status).toBe('ok');
    expect(check.steps.find((s) => s.id === 'vision')?.ok).toBe(false);
    for (let i = 0; i < 8; i += 1) tick(Date.now() + (i + 1) * 5_000);
    const map = (await call<T.CourseMap>('GET', `/courses/${course.id}/map`, undefined, t)).data;
    expect(map.chapters.length).toBeGreaterThan(0);
    const bad = (await call<T.Connection>('POST', '/me/providers', { preset_id: 'kimi', key: 'sk-bad-key-000000' }, t)).data;
    const failed = (await call<T.CheckResult>('POST', `/me/providers/${bad.id}/check`, {}, t)).data;
    expect(failed.steps[0]!.ok).toBe(false);
  });
});
