// 生成接口合同的样例响应（docs/接口合同/samples-v1/）：SAMPLES_DIR=<目录> npx vitest run tests/unit/samples.test.ts
// 样例来自演示后端，与前端实际使用的形状一致；没有设置 SAMPLES_DIR 时跳过。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as T from '../../src/api/types';
import { mockConfig } from '../../src/mock/config';
import { resetDb } from '../../src/mock/db';
import { tick } from '../../src/mock/jobs';
import { mockFetch } from '../../src/mock/server';

const dir = process.env.SAMPLES_DIR;
mockConfig.latency = false;
mockConfig.speed = 0;

async function call<R = any>(method: string, path: string, body?: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await mockFetch(new Request(`http://test/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  const type = res.headers.get('Content-Type') ?? '';
  return (type.includes('ndjson') ? text.trim().split('\n').map((l) => JSON.parse(l)) : text ? JSON.parse(text) : null) as R;
}

describe.skipIf(!dir)('合同样例', () => {
  it('写出样例', async () => {
    resetDb();
    const out: Record<string, unknown> = {};
    const save = (name: string, data: unknown) => { out[name] = data; };
    const device = { kind: 'browser', name: 'Chrome 浏览器', timezone: 'America/Los_Angeles' };
    save('GET-health', await call('GET', '/health'));
    save('POST-auth-sms', await call('POST', '/auth/sms', { phone: '13800000000' }));
    const tokens = await call<T.Tokens>('POST', '/auth/login', { phone: '13800000000', code: '123456', device });
    save('POST-auth-login', tokens);
    const t = tokens.access_token;
    save('GET-me', await call('GET', '/me', undefined, t));
    save('GET-me-settings', await call('GET', '/me/settings', undefined, t));
    save('GET-providers-presets', await call('GET', '/providers/presets'));
    const providers = await call<T.Connection[]>('GET', '/me/providers', undefined, t);
    save('GET-me-providers', providers);
    save('POST-me-providers-id-check', await call('POST', `/me/providers/${providers[0]!.id}/check`, {}, t));
    save('GET-me-models', await call('GET', '/me/models', undefined, t));
    save('GET-me-usage', await call('GET', '/me/usage?period=week', undefined, t));
    save('GET-me-limits', await call('GET', '/me/limits', undefined, t));
    const today = await call<T.Today>('GET', '/today', undefined, t);
    save('GET-today', today);
    save('PATCH-tasks-id', await call('PATCH', `/tasks/${today.tasks[0]!.id}`, { status: 'done' }, t));
    save('GET-schedule', await call('GET', '/schedule', undefined, t));
    const courses = await call<T.Course[]>('GET', '/courses', undefined, t);
    save('GET-courses', courses);
    const os = courses.find((c) => c.name === '操作系统')!;
    const home = await call<T.CourseHome>('GET', `/courses/${os.id}/home`, undefined, t);
    save('GET-courses-id-home', home);
    const kp = home.map.chapters.flatMap((c) => c.kps).find((k) => k.title === '银行家算法')!;
    const detail = await call<T.KpDetail>('GET', `/kps/${kp.id}`, undefined, t);
    save('GET-kps-id', detail);
    save('POST-kps-id-understood', await call('POST', `/kps/${kp.id}/understood`, {}, t));
    const materials = await call<T.Material[]>('GET', `/courses/${os.id}/materials`, undefined, t);
    save('GET-courses-id-materials', materials);
    save('GET-materials-id-pages-n', await call('GET', `/materials/${detail.pages[0]!.material_id}/pages/${detail.pages[0]!.page}`, undefined, t));
    save('GET-courses-id-focus', await call('GET', `/courses/${os.id}/focus`, undefined, t));
    save('GET-courses-id-exam-format', await call('GET', `/courses/${os.id}/exam-format`, undefined, t));
    save('GET-practice', await call('GET', '/practice', undefined, t));
    const session = await call<T.Session>('POST', '/sessions', { kind: 'quick', course_id: os.id, count: 3 }, t);
    save('POST-sessions', session);
    tick(Date.now() + 60_000);
    tick(Date.now() + 120_000);
    const ready = await call<T.Session>('GET', `/sessions/${session.id}`, undefined, t);
    save('GET-sessions-id', ready);
    const q = ready.questions.find((x) => x.type === 'single') ?? ready.questions[0]!;
    save('POST-questions-id-hint', await call('POST', `/questions/${q.id}/hint`, { level: 1 }, t));
    save('POST-questions-id-attempt', await call('POST', `/questions/${q.id}/attempt`, { response: q.options?.[0]?.id ?? '答案' }, t));
    save('POST-sessions-id-finish', await call('POST', `/sessions/${session.id}/finish`, {}, t));
    save('GET-mistakes', await call('GET', '/mistakes', undefined, t));
    save('GET-courses-id-insight', await call('GET', `/courses/${os.id}/insight`, undefined, t));
    const threads = await call<T.Thread[]>('GET', '/threads', undefined, t);
    save('GET-threads', threads);
    const thread = threads.find((x) => x.course_id === os.id)!;
    save('POST-threads-id-messages.ndjson', await call('POST', `/threads/${thread.id}/messages`, { text: '把操作系统挪到明天', context: { route: '/', course_id: os.id } }, t));
    save('GET-threads-id', await call('GET', `/threads/${thread.id}`, undefined, t));
    save('GET-notifications', await call('GET', '/notifications', undefined, t));
    save('GET-plugins', await call('GET', '/plugins', undefined, t));
    save('GET-plugins-id', await call('GET', '/plugins/compute-first', undefined, t));
    save('ERROR-needs_confirmation', await call('POST', '/sessions', { kind: 'mock', course_id: os.id }, t));
    save('ERROR-unauthorized', await call('GET', '/today'));
    mkdirSync(dir!, { recursive: true });
    for (const [name, data] of Object.entries(out)) writeFileSync(join(dir!, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
    expect(Object.keys(out).length).toBeGreaterThan(30);
  });
});
