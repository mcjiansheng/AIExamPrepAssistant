// 渲染与交互的小工具：转义模板、事件委托、弹层、提示。

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(v) {
  if (v == null || v === false) return '';
  if (v === true) return 'true';   // 用于 aria-pressed="${x}" 这类属性；false 渲染为空
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}

/** 模板标签：插值自动转义；嵌套的 html`` 结果不会被二次转义 */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? fmt(vals[i]) : ''); });
  return new Raw(out);
}
export const raw = (s) => new Raw(s);

/**
 * 事件委托：元素上写 data-act="名字"，handlers[名字](元素, 事件)。
 * 处理函数抛出的错误统一用红色提示显示，不会让页面卡住。
 */
export function bind(root, handlers) {
  const run = async (e, type) => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const name = t.dataset.act;
    const fn = handlers[name];
    if (!fn) return;
    const want = t.dataset.on || (t.matches('input, select, textarea') ? 'change' : 'click');
    if (want !== type) return;
    if (type === 'click' || type === 'submit') e.preventDefault();
    try { await fn(t, e); } catch (err) { showError(err); }
  };
  for (const type of ['click', 'change', 'input', 'submit', 'keydown']) root.addEventListener(type, (e) => run(e, type));
}

export function showError(err) {
  console.error(err);
  toast(err?.message || '操作没有完成，请重试', { tone: 'error' });
}

export function toast(msg, { action, onAction, tone, ms = 3200 } = {}) {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (tone ? ' ' + tone : '');
  t.innerHTML = html`<span>${msg}</span>${action ? html`<button type="button">${action}</button>` : ''}`;
  const close = () => t.remove();
  if (action) t.querySelector('button').onclick = async () => { close(); try { await onAction(); } catch (e) { showError(e); } };
  box.append(t);
  setTimeout(close, action ? ms + 2000 : ms);
}

/**
 * 弹层：手机上从底部弹出，宽屏居中。返回 { el, close }。
 * body 是 html`` 结果；handlers 同 bind；按 Esc 或点遮罩关闭。
 */
export function sheet({ title, body, foot, handlers = {}, wide = false, onClose }) {
  const layer = document.getElementById('layer');
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = html`<div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-act="__close" aria-label="关闭">✕</button></div>
    <div class="sheet-body">${body}</div>
    ${foot ? html`<div class="sheet-foot">${foot}</div>` : ''}
  </div>`;
  const prevFocus = document.activeElement;
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  bind(scrim, { __close: close, ...handlers });
  layer.append(scrim);
  const first = scrim.querySelector('input, textarea, select') || scrim.querySelector('.sheet-foot .btn') || scrim.querySelector('[data-act="__close"]');
  first?.focus();
  return { el: scrim, close };
}

export function confirmSheet({ title, text, ok, danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const s = sheet({
      title,
      body: html`<p class="muted">${text}</p>`,
      foot: html`<button class="btn ghost" data-act="no">取消</button><button class="btn${danger ? ' danger' : ''}" data-act="yes">${ok}</button>`,
      handlers: {
        yes: () => { answered = true; s.close(); resolve(true); },
        no: () => { answered = true; s.close(); resolve(false); },
      },
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

/* ---------- 格式化 ---------- */

const WEEK = '日一二三四五六';
export function fmtDate(iso, { week = false } = {}) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  const s = `${d.getMonth() + 1}月${d.getDate()}日`;
  return week ? `${s} 周${WEEK[d.getDay()]}` : s;
}
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function fmtMin(m) {
  if (m == null) return '';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
export const pct = (x) => `${Math.round((x || 0) * 100)}%`;
