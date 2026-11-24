// 本套结果：得分、掌握度变化、按结果重排计划
import { api } from '../api.js';
import { html, bind, toast, todayISO } from '../ui.js';
import { MASTERY, QTYPE } from '../labels.js';

export async function mount(el, ctx) {
  const { cid, eid } = ctx.params;
  const r = await api.examResult(eid);
  const { exam } = r;
  const live = exam.questions.filter((q) => q.status !== 'hidden');
  const right = live.filter((q) => q.attempt && q.attempt.score >= q.score).length;
  const wrong = live.filter((q) => q.attempt && q.attempt.score < q.score);
  const better = r.mastery_changes.filter((c) => rank(c.to) > rank(c.from));
  const worse = r.mastery_changes.filter((c) => rank(c.to) <= rank(c.from));

  el.innerHTML = html`<div class="page">
    <div class="page-head"><div><h1>${exam.title}</h1><p class="sub">${live.length} 道题，全对 ${right} 道</p></div></div>
    <div class="panel pad" style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap">
      <div class="score-big">${exam.score}<small> / ${exam.total} 分</small></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${wrong.length ? html`<a class="btn ghost" href="#/c/${cid}/exam/${eid}">回看错题</a>` : ''}
        ${r.plan_stale ? html`<button class="btn" data-act="replan">按结果重排计划</button>` : html`<a class="btn" href="#/c/${cid}/plan">回到计划</a>`}
      </div>
    </div>

    ${r.mastery_changes.length ? html`<section class="section"><h2>掌握情况的变化</h2>
      <div class="panel">
        ${better.map((c) => change(c, 'green'))}
        ${worse.map((c) => change(c, 'red'))}
      </div></section>` : ''}

    ${wrong.length ? html`<section class="section"><h2>没拿满分的题</h2>
      <ul class="panel list">${wrong.map((q) => html`<li><a class="row row-link" href="#/c/${cid}/exam/${eid}" data-act="open" data-i="${exam.questions.indexOf(q)}">
        <div class="grow"><div class="title">第 ${q.index} 题，${QTYPE[q.type]}</div><div class="meta">${q.topic_title}</div></div>
        <span class="muted small">${q.attempt.score} / ${q.score}</span></a></li>`)}</ul></section>` : ''}
  </div>`;

  bind(el, {
    replan: async () => {
      const { plan } = await api.plan(cid);
      if (plan) await api.makePlan(cid, { days: plan.days, hours_per_day: plan.hours_per_day, start_date: todayISO() });
      toast(plan ? '计划已重排' : '去生成一份计划吧');
      ctx.go(`#/c/${cid}/plan`);
    },
    open: () => ctx.go(`#/c/${cid}/exam/${eid}`),
  });
}

const rank = (m) => ({ new: 0, shaky: 1, mastered: 2 }[m]);
const change = (c, tone) => html`<div class="chg"><span class="grow">${c.title}</span>
  <span class="muted small">${MASTERY[c.from]}</span><span class="muted">→</span><span class="tag ${tone}">${MASTERY[c.to]}</span></div>`;
