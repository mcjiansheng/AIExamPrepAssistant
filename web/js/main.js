// 入口：路由、外壳（侧栏 / 顶栏 / 底部标签）、轮询管理。
import { api, initApi, apiMode } from './api.js';
import { html, bind, toast, showError, fmtDate } from './ui.js';
import { STEPS, stepDot } from './labels.js';
import * as home from './views/home.js';
import * as materials from './views/materials.js';
import * as focus from './views/focus.js';
import * as plan from './views/plan.js';
import * as practice from './views/practice.js';
import * as exam from './views/exam.js';
import * as result from './views/result.js';
import { initAssistant, setCourse as assistCourse } from './assistant.js';

const STEP_VIEWS = { materials, focus, plan, practice };

const routes = [
  [/^\/?$/, () => ({ view: home })],
  [/^\/c\/([^/]+)\/?$/, ([cid]) => ({ cid, redirect: true })],
  [/^\/c\/([^/]+)\/(materials|focus|plan|practice)$/, ([cid, step]) => ({ cid, step, view: STEP_VIEWS[step] })],
  [/^\/c\/([^/]+)\/exam\/([^/]+)$/, ([cid, eid]) => ({ cid, eid, view: exam, immersive: true })],
  [/^\/c\/([^/]+)\/exam\/([^/]+)\/result$/, ([cid, eid]) => ({ cid, eid, view: result })],
];

const $ = (s) => document.querySelector(s);
let current = { cleanup: [], token: 0 };
let courseCache = [];

function match(hash) {
  const path = hash.replace(/^#/, '') || '/';
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) return fn(m.slice(1).map(decodeURIComponent));
  }
  return null;
}

export const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

async function route() {
  for (const fn of current.cleanup) fn();
  const token = ++current.token;
  current = { cleanup: [], token };
  const r = match(location.hash);
  if (!r) return go('#/');

  let course = null;
  try {
    courseCache = await api.courses();
    if (r.cid) course = await api.course(r.cid);
  } catch (err) {
    if (err.status === 404) { toast('这门课不存在了'); return go('#/'); }
    return renderFatal(err);
  }
  if (token !== current.token) return;
  if (r.redirect) return go(`#/c/${course.id}/${course.next_step}`);

  document.body.classList.toggle('no-course', !course);
  document.body.classList.toggle('immersive', !!r.immersive);
  renderShell(course, r.step);
  assistCourse(course, r.step || (r.immersive ? 'exam' : r.view === result ? 'result' : null));

  const view = $('#view');
  const el = document.createElement('div');
  view.replaceChildren(el);
  window.scrollTo(0, 0);

  const ctx = {
    course, params: r, go,
    poll(fn, ms = 1500) {
      let busy = false;
      const t = setInterval(async () => {
        if (busy || document.hidden) return;
        busy = true;
        try { await fn(); } catch (e) { console.error(e); } finally { busy = false; }
      }, ms);
      current.cleanup.push(() => clearInterval(t));
      return () => clearInterval(t);
    },
    onLeave(fn) { current.cleanup.push(fn); },
    /** 视图里的数据变化可能影响步骤状态点，刷新外壳 */
    async refreshShell() {
      if (token !== current.token) return;
      courseCache = await api.courses();
      if (course) { ctx.course = course = await api.course(course.id); }
      if (token === current.token) renderShell(course, r.step);
    },
  };
  try {
    await r.view.mount(el, ctx);
  } catch (err) {
    if (token !== current.token) return;
    showError(err);
    el.innerHTML = html`<div class="page"><div class="panel pad error-state">
      <h2 class="serif">这一页没有加载出来</h2><p class="muted">${err.message || '未知错误'}</p>
      <button class="btn" data-act="retry">重新加载</button></div></div>`;
    bind(el, { retry: route });
  }
}

function renderFatal(err) {
  $('#view').innerHTML = html`<div class="page"><div class="panel pad error-state">
    <h2 class="serif">连不上数据</h2><p class="muted">${err.message}</p>
    <button class="btn" onclick="location.reload()">重新加载</button></div></div>`;
}

function daysLeft(c) {
  if (c.days_left == null) return '';
  if (c.days_left < 0) return '已考完';
  if (c.days_left === 0) return '今天考试';
  return html`还有 <b>${c.days_left}</b> 天`;
}

const mockTag = () => (apiMode() === 'mock' ? html`<span class="tag amber tb-mock" title="没有连上后端，正在用演示数据">演示</span>` : '');

function renderShell(course, step) {
  // 侧栏（宽屏）
  $('#rail').innerHTML = html`
    <a class="brand" href="#/"><span class="mark">备考</span>助手</a>
    <div class="rail-label">我的课程</div>
    ${courseCache.map((c) => html`
      <a class="rail-course" href="#/c/${c.id}" aria-current="${course?.id === c.id}">
        <span>${c.name}</span><span class="d">${c.days_left != null && c.days_left >= 0 ? `${c.days_left} 天` : ''}</span>
      </a>
      ${course?.id === c.id ? html`<div class="rail-steps">${STEPS.map(([k, label], i) => html`
        <a href="#/c/${c.id}/${k}" ${step === k ? html`aria-current="page"` : ''}>${stepDot(course.steps[k], i + 1)}${label}</a>`)}</div>` : ''}
    `)}
    <a class="rail-course" href="#/" data-new="1"><span class="muted">＋ 新建课程</span></a>
    <div class="rail-foot">${apiMode() === 'mock' ? html`当前是演示数据。<button data-act="reset">重置演示数据</button>` : ''}</div>`;

  // 顶栏（手机）
  $('#topbar').innerHTML = course
    ? html`<button class="back" onclick="location.hash='#/'" aria-label="返回课程列表">‹</button>
        <div class="tb-title">${course.name}</div>
        <div class="tb-side countdown" title="${course.exam_date ? fmtDate(course.exam_date) + '考试' : ''}">${daysLeft(course)}</div>${mockTag()}`
    : html`<div class="tb-title">备考助手</div>${mockTag()}`;

  // 底部标签（手机）
  $('#tabbar').innerHTML = course ? html`${STEPS.map(([k, label], i) => html`
    <a href="#/c/${course.id}/${k}" ${step === k ? html`aria-current="page"` : ''}>
      ${stepDot(course.steps[k], i + 1)}<span class="tab-label">${label}</span>
    </a>`)}` : '';
}

async function boot() {
  const mode = await initApi();
  bind($('#rail'), {
    reset: async () => {
      const { resetMock } = await import('./mock/server.js');
      resetMock();
      toast('演示数据已重置');
      go('#/');
    },
  });
  $('#rail').addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) { e.preventDefault(); go('#/'); setTimeout(() => document.querySelector('[data-act="new"]')?.click(), 300); }
  });
  initAssistant();
  window.addEventListener('hashchange', route);
  // 助手执行了操作：刷新当前页（作答页自己处理，避免丢掉做题进度）
  window.addEventListener('data-changed', () => { if (!document.body.classList.contains('immersive')) route(); });
  route();
}

boot();
