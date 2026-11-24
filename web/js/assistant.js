// 备考助手：叠在课程内各页上的对话面板。接口见合同第 10 节，交互见设计文档 4.8。
import { api } from './api.js';
import { html, raw, esc, bind, toast, showError } from './ui.js';
import { refTag, openPage } from './views/blocks.js';

const VIEW_NAME = { materials: '资料', focus: '重点', plan: '计划', practice: '练习', exam: '作答', result: '结果' };
const EXAMPLES = {
  materials: ['讲讲信号量和 PV 操作', '老师说第四章只考概念'],
  focus: ['老师说管程不考，银行家算法要会算', '期末是 10 道选择题和 3 道计算题', '讲讲页面置换算法'],
  plan: ['我只剩 3 天，每天 2 小时', '固定死锁为必学', '讲讲银行家算法'],
  practice: ['出 5 道磁盘调度的题', '死锁那块我还是不会，讲讲'],
  result: ['出 5 道死锁的题', '讲讲页面置换算法'],
  exam: ['这题怎么想', '告诉我答案'],
};

let course = null;
let ctx = { view: 'plan' };
let messages = [];
let streaming = false;
let open = false;
let lastText = '';
let failed = null;      // 上一次出错的信息

const $ = (s) => document.querySelector(s);

export function setCourse(c, view) {
  const changed = c?.id !== course?.id;
  course = c;
  ctx = { view };
  document.body.classList.toggle('has-assist', !!c);
  if (!c) { close(); return; }
  if (changed) { messages = []; failed = null; if (open) load(); }
  renderHead();
}
export function setContext(partial) { ctx = { ...ctx, ...partial }; renderHead(); }

export function toggle() { open ? close() : show(); }
export function show() {
  if (!course) return;
  open = true;
  document.body.classList.add('assist-open');
  $('#assist').hidden = false;
  load().then(() => $('#assistInput')?.focus());
}
function close() {
  open = false;
  document.body.classList.remove('assist-open');
  const el = $('#assist');
  if (el) el.hidden = true;
}

async function load() {
  if (!course) return;
  try { messages = (await api.chatHistory(course.id)).messages; } catch (e) { showError(e); }
  renderLog(true);
}

function renderHead() {
  const el = $('#assistCtx');
  if (!el) return;
  el.textContent = course ? `${course.name}，在看${VIEW_NAME[ctx.view] || ''}${ctx.question_id ? '中的这道题' : ''}` : '';
  if (open && !messages.length) renderLog();
}

/* ---------- 渲染 ---------- */

function md(text) {
  // 只支持段落、换行和 **加粗**；先转义
  return raw(esc(text).split(/\n{2,}/).map((p) => `<p>${p.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`).join(''));
}

const actionCard = (a) => html`<div class="act-card ${a.undone ? 'undone' : ''}">
  <span class="act-ok" aria-hidden="true">✓</span>
  <span class="grow">${a.summary}</span>
  ${a.undone ? html`<span class="muted small">已撤销</span>` : html`
    ${a.href ? html`<a class="link" href="${a.href}" data-act="goto">去看看</a>` : ''}
    ${a.undoable ? html`<button class="link" data-act="undo" data-id="${a.id}">撤销</button>` : ''}`}
</div>`;

const proposalCard = (p) => html`<div class="prop-card">
  <div class="prop-title">${p.summary}</div>
  ${p.changes.length ? html`<ul class="prop-changes">${p.changes.map((c) => html`<li><span>${c.label}</span><span class="muted">${c.from}</span><span aria-hidden="true">→</span><b>${c.to}</b></li>`)}</ul>` : html`<p class="muted small">和现在的设置一样</p>`}
  ${p.status === 'pending' ? html`<div class="prop-btns"><button class="btn small" data-act="accept" data-id="${p.id}">确认</button><button class="btn ghost small" data-act="decline" data-id="${p.id}">不用了</button></div>`
    : html`<p class="muted small">${p.status === 'accepted' ? '已确认' : '没有修改'}</p>`}
</div>`;

function msgView(m) {
  if (m.role === 'user') return html`<div class="msg me">${m.text}</div>`;
  const running = (m.running || []).map((t) => html`<div class="tool-line run">${t.label}</div>`);
  return html`<div class="msg ai">
    ${m.tools.map((t) => html`<div class="tool-line">${t.label}</div>`)}${running}
    ${m.text ? html`<div class="md">${md(m.text)}</div>` : (m.running?.length ? '' : html`<div class="typing" aria-label="正在回答"><i></i><i></i><i></i></div>`)}
    ${m.refs.length ? html`<div class="tags">${m.refs.map(refTag)}</div>` : ''}
    ${m.actions.map(actionCard)}
    ${m.proposals.map(proposalCard)}
  </div>`;
}

function renderLog(scroll = true) {
  const log = $('#assistLog');
  if (!log) return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = messages.length
    ? html`${messages.map(msgView)}${failed ? html`<div class="chat-err"><span>${failed}</span><button class="link" data-act="retry">重试</button></div>` : ''}`
    : html`<div class="assist-empty">
        <p class="serif">问我，或者让我帮你改</p>
        <p class="muted small">讲解会标出课件页码；能撤销的操作我直接做，改考试形式会先问你。</p>
        <div class="chips">${(EXAMPLES[ctx.view] || EXAMPLES.plan).map((t) => html`<button class="chip" data-act="example">${t}</button>`)}</div>
      </div>`;
  if (scroll && (nearBottom || streaming)) log.scrollTop = log.scrollHeight;
}

/* ---------- 发送与事件 ---------- */

async function send(text) {
  text = text.trim();
  if (!text || streaming || !course) return;
  lastText = text;
  failed = null;
  streaming = true;
  setBusy(true);
  messages.push({ role: 'user', text, tools: [], refs: [], actions: [], proposals: [] });
  const m = { role: 'assistant', text: '', tools: [], refs: [], actions: [], proposals: [], running: [] };
  messages.push(m);
  renderLog();
  const affects = new Set();
  try {
    await api.chat(course.id, text, ctx, (ev) => {
      if (ev.type === 'text') m.text += ev.delta;
      if (ev.type === 'tool') {
        if (ev.status === 'running') m.running.push(ev);
        else { m.running = m.running.filter((t) => t.id !== ev.id); m.tools.push({ label: ev.label }); }
      }
      if (ev.type === 'refs') m.refs.push(...ev.refs);
      if (ev.type === 'action') { m.actions.push(ev.action); ev.action.affects.forEach((a) => affects.add(a)); }
      if (ev.type === 'proposal') m.proposals.push(ev.proposal);
      if (ev.type === 'error') failed = ev.message;
      renderLog();
    });
  } catch (e) {
    failed = e.message;
  } finally {
    m.running = [];
    streaming = false;
    setBusy(false);
    renderLog();
    if (affects.size) dataChanged([...affects]);
  }
}

function setBusy(b) {
  const btn = $('#assistSend');
  if (btn) btn.disabled = b;
}

function dataChanged(affects) {
  window.dispatchEvent(new CustomEvent('data-changed', { detail: { affects } }));
}

export function initAssistant() {
  const root = $('#assist');
  root.innerHTML = html`
    <header class="assist-head">
      <div class="grow"><h2>备考助手</h2><div class="muted small" id="assistCtx"></div></div>
      <button class="icon-btn" data-act="clear" title="清空对话" aria-label="清空对话">⟲</button>
      <button class="icon-btn" data-act="close" aria-label="收起助手">✕</button>
    </header>
    <div class="assist-log" id="assistLog" aria-live="polite"></div>
    <form class="assist-input" data-act="send" data-on="submit">
      <textarea id="assistInput" rows="1" placeholder="问我，或者让我帮你改计划" aria-label="给助手的消息"></textarea>
      <button class="btn small" id="assistSend" type="submit">发送</button>
    </form>`;
  const input = $('#assistInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const t = input.value; input.value = ''; autosize(); send(t); }
  });
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  input.addEventListener('input', autosize);

  bind(root, {
    send: () => { const t = input.value; input.value = ''; autosize(); send(t); },
    example: (b) => send(b.textContent),
    close,
    clear: async () => { await api.clearChat(course.id); messages = []; failed = null; renderLog(); },
    retry: () => { messages.splice(-2, 2); send(lastText); },
    goto: (a) => { if (window.matchMedia('(max-width: 959px)').matches) close(); location.hash = a.getAttribute('href'); },
    undo: async (b) => {
      const r = await api.undoAction(b.dataset.id);
      for (const m of messages) for (const a of m.actions) if (a.id === b.dataset.id) { a.undone = true; dataChanged(a.affects); }
      renderLog(false);
      toast(r.summary);
    },
    accept: (b) => decide(b.dataset.id, true),
    decline: (b) => decide(b.dataset.id, false),
    ref: (b) => openPage(b.dataset.mid, +b.dataset.page, b.textContent),
  });

  async function decide(pid, accept) {
    const r = await api.answerProposal(pid, accept);
    for (const m of messages) for (const p of m.proposals) if (p.id === pid) p.status = accept ? 'accepted' : 'declined';
    renderLog(false);
    toast(r.summary);
    if (accept) dataChanged(['focus', 'practice']);
  }

  $('#assistFab').addEventListener('click', toggle);
}
