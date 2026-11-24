// 计划：按天（默认）/ 取舍；主题详情、固定与放弃
import { api } from '../api.js';
import { html, bind, sheet, toast, fmtDate, fmtMin, todayISO } from '../ui.js';
import { ITEM_KIND, mark } from '../labels.js';

export async function mount(el, ctx) {
  const cid = ctx.course.id;
  let plan = null, limited = false, hasTopics = true;
  let view = 'days';
  let form = null;   // 正在编辑的天数和小时数

  const load = async () => {
    const [p, t] = await Promise.all([api.plan(cid), api.topics(cid)]);
    plan = p.plan; limited = t.limited_basis; hasTopics = t.chapters.length > 0;
    form = { days: plan?.days ?? Math.max(1, Math.min(60, ctx.course.days_left || 7)), hours: plan?.hours_per_day ?? 3 };
  };

  const settings = (primary) => html`<div class="plan-set">
    <span class="lbl">复习</span>
    <span class="stepper"><button data-act="adj" data-k="days" data-d="-1" aria-label="少一天">−</button><input type="number" min="1" max="60" value="${form.days}" data-act="setv" data-k="days" aria-label="天数"><button data-act="adj" data-k="days" data-d="1" aria-label="多一天">＋</button></span>
    <span class="lbl">天，每天</span>
    <span class="stepper"><button data-act="adj" data-k="hours" data-d="-0.5" aria-label="少半小时">−</button><input type="number" min="0.5" max="16" step="0.5" value="${form.hours}" data-act="setv" data-k="hours" aria-label="小时数"><button data-act="adj" data-k="hours" data-d="0.5" aria-label="多半小时">＋</button></span>
    <span class="lbl">小时</span>
    ${primary}
  </div>`;

  const render = () => {
    if (!hasTopics) {
      el.innerHTML = html`<div class="page"><div class="page-head"><div><h1>计划</h1></div></div>
        <div class="panel empty"><h2>先上传资料</h2><p>计划按课件里整理出的主题来排。资料整理好之后回到这里。</p>
        <a class="btn" href="#/c/${cid}/materials">去上传资料</a></div></div>`;
      return;
    }
    if (!plan) {
      el.innerHTML = html`<div class="page">
        <div class="page-head"><div><h1>计划</h1><p class="sub">告诉我还有多少时间，按重点排出每天学什么</p></div></div>
        ${limited ? limitedNotice() : ''}
        <div class="panel pad" style="display:flex;flex-direction:column;gap:16px">${settings('')}
          <button class="btn" data-act="make" style="align-self:flex-start">生成计划</button></div>
      </div>`;
      return;
    }
    const changed = form.days !== plan.days || form.hours !== plan.hours_per_day;
    el.innerHTML = html`<div class="page">
      <div class="page-head"><div><h1>计划</h1>
        <p class="sub">共 ${fmtMin(plan.total_min)}，其中 ${fmtMin(plan.reserved_min)} 留给模拟卷和错题</p></div></div>
      <div class="panel pad">${settings(changed || plan.stale ? html`<button class="btn small" data-act="make">重排计划</button>` : '')}</div>
      ${plan.stale ? html`<div class="notice info"><span class="grow">重点或掌握情况有变化，重排一下计划会更准。</span></div>` : ''}
      ${plan.limited_basis ? limitedNotice() : ''}
      <div class="seg" role="group" aria-label="视图">
        <button aria-pressed="${view === 'days'}" data-act="view" data-v="days">按天</button>
        <button aria-pressed="${view === 'buckets'}" data-act="view" data-v="buckets">取舍</button>
      </div>
      ${view === 'days' ? daysView() : bucketsView()}
    </div>`;
  };

  const limitedNotice = () => html`<div class="notice"><span class="grow">老师的重点很少，计划主要按内容量排。</span><a class="link" href="#/c/${cid}/focus">去补充重点</a></div>`;

  const daysView = () => {
    const today = todayISO();
    const firstIdx = Math.max(0, plan.schedule.findIndex((d) => d.date >= today));
    return html`<div class="panel">${plan.schedule.map((d, i) => {
      const total = d.items.reduce((s, x) => s + x.minutes, 0);
      const doneAll = d.items.length && d.items.every((x) => x.done);
      const label = d.date === today ? '今天' : fmtDate(d.date);
      return html`<details class="day ${d.date === today ? 'today' : ''}" ${i === firstIdx ? 'open' : ''}>
        <summary><span class="d">${label}<span class="w">${d.date === today ? fmtDate(d.date, { week: true }) : fmtDate(d.date, { week: true }).slice(-2)}</span></span>
          <span class="t">${d.items.length ? (doneAll ? '已完成' : fmtMin(total)) : '休息'}</span></summary>
        <div class="day-items">${d.items.map(itemRow)}</div>
      </details>`;
    })}</div>`;
  };

  const itemRow = (it) => html`<div class="item ${it.done ? 'done' : ''}">
    <button class="check" data-act="done" data-id="${it.id}" data-done="${it.done}" aria-label="${it.done ? '标为未完成' : '标为完成'}" aria-pressed="${it.done}">✓</button>
    <div class="grow">${it.topic_id
      ? html`<button class="ttl" data-act="topic" data-tid="${it.topic_id}">${it.title}</button>`
      : html`<span class="ttl">${it.title}</span>`}</div>
    ${ITEM_KIND[it.kind] ? html`<span class="tag ${it.kind === 'mock' ? 'pen' : ''}">${ITEM_KIND[it.kind]}</span>` : ''}
    <span class="mins">${fmtMin(it.minutes)}</span>
  </div>`;

  const bucketsView = () => {
    const groups = [['must', '必学', '在时间内'], ['maybe', '有时间再学', '排在时间之外的前一段'], ['drop', '本次放弃', '']];
    return html`<div class="panel">${groups.map(([k, name]) => {
      const list = plan.buckets[k];
      const mins = list.reduce((s, t) => s + t.minutes, 0);
      return html`<div class="bucket">
        <div class="bucket-head"><h3>${name}</h3><span>${list.length} 个主题${mins ? `，${fmtMin(mins)}` : ''}</span></div>
        ${list.length ? html`<ul class="list">${list.map((t) => html`<li><button class="row row-link" data-act="topic" data-tid="${t.topic_id}">
          <div class="grow"><div class="title">${t.title}</div>
            <div class="meta">${t.reasons[0]}${t.pinned ? html` <span class="pin">，已固定</span>` : ''}</div></div>
          ${t.minutes ? html`<span class="mins muted small">${fmtMin(t.minutes)}</span>` : ''}</button></li>`)}</ul>`
          : html`<p class="muted small" style="padding:0 16px 14px">没有</p>`}
      </div>`;
    })}</div>`;
  };

  const findTopic = (tid) => {
    for (const k of ['must', 'maybe', 'drop']) { const t = plan.buckets[k].find((x) => x.topic_id === tid); if (t) return { t, bucket: k }; }
    return null;
  };

  function topicSheet(tid) {
    const found = findTopic(tid);
    if (!found) return;
    const { t, bucket } = found;
    const pinAct = async (pin, msg) => {
      const prev = t.pinned;
      s.close();
      plan = await api.pin(cid, tid, pin);
      render();
      toast(msg, { action: '撤销', onAction: async () => { plan = await api.pin(cid, tid, prev); render(); } });
    };
    const s = sheet({
      title: t.title,
      body: html`<p class="muted small" style="margin-top:-10px">${t.chapter_title}，约 ${fmtMin(t.minutes)}</p>
        <div class="tags">${t.reasons.map((r) => html`<span class="tag ${/强调|固定/.test(r) ? 'pen' : /不考|放弃/.test(r) ? '' : /依据有限/.test(r) ? 'amber' : ''}">${r}</span>`)}</div>
        ${t.focus_kps.length ? html`<div class="section"><h3 class="small muted" style="font-weight:500">老师的重点落在这几个知识点</h3>
          <div class="kps">${t.focus_kps.map((k) => mark(k.title, k.level))}</div></div>` : ''}
        <div class="mastery"><span>${t.mastery.total} 个知识点里掌握 ${t.mastery.mastered} 个</span>
          <div class="bar green"><i style="width:${t.mastery.total ? (t.mastery.mastered / t.mastery.total) * 100 : 0}%"></i></div></div>`,
      foot: t.pinned
        ? html`<button class="btn ghost" data-act="unpin">取消固定</button>`
        : html`${bucket !== 'must' ? html`<button class="btn" data-act="must">固定为必学</button>` : ''}${bucket !== 'drop' ? html`<button class="btn ghost" data-act="drop">放弃这个主题</button>` : ''}`,
      handlers: {
        must: () => pinAct('must', '已固定为必学，计划已更新'),
        drop: () => pinAct('drop', '已放弃，计划已更新'),
        unpin: () => pinAct(null, '已取消固定，计划已更新'),
      },
    });
  }

  bind(el, {
    adj: (b) => { const k = b.dataset.k; const lim = k === 'days' ? [1, 60] : [0.5, 16]; form[k] = Math.min(lim[1], Math.max(lim[0], +(form[k] + +b.dataset.d).toFixed(1))); render(); },
    setv: (inp) => { const k = inp.dataset.k; const lim = k === 'days' ? [1, 60] : [0.5, 16]; form[k] = Math.min(lim[1], Math.max(lim[0], +inp.value || lim[0])); if (k === 'days') form[k] = Math.round(form[k]); render(); },
    make: async () => {
      const first = !plan;
      plan = await api.makePlan(cid, { days: form.days, hours_per_day: form.hours, start_date: todayISO() });
      view = 'days';
      render(); ctx.refreshShell();
      toast(first ? '计划已生成' : '计划已重排');
    },
    view: (b) => { view = b.dataset.v; render(); },
    topic: (b) => topicSheet(b.dataset.tid),
    done: async (b) => {
      const done = b.dataset.done !== 'true';
      const it = await api.setItemDone(b.dataset.id, done);
      for (const d of plan.schedule) for (const x of d.items) if (x.id === it.id) x.done = it.done;
      const openIdx = [...el.querySelectorAll('details.day')].map((d) => d.open);
      render();
      el.querySelectorAll('details.day').forEach((d, i) => { d.open = openIdx[i]; });
    },
  });

  await load(); render();
}
