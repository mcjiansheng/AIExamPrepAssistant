// 练习：试卷列表、出一套题
import { api } from '../api.js';
import { html, bind, sheet, confirmSheet, toast, fmtDate } from '../ui.js';

export async function mount(el, ctx) {
  const cid = ctx.course.id;
  let exams, hasTopics, hasShaky;
  const load = async () => {
    const [list, topics] = await Promise.all([api.exams(cid), api.topics(cid)]);
    exams = list;
    hasTopics = topics.chapters.length > 0;
    hasShaky = topics.chapters.some((c) => c.topics.some((t) => t.mastery.shaky > 0));
  };
  const progress = (e) => e.status === 'finished' ? `得分 ${e.score} / ${e.total}`
    : e.status === 'failed' ? '出题失败' : e.status === 'generating' ? '出题中' : `做到 ${e.answered} / ${e.question_count}`;

  const render = () => { el.innerHTML = html`<div class="page">
    <div class="page-head">
      <div><h1>练习</h1><p class="sub">出好的题可以先做，没出好的会接着出现</p></div>
      ${exams.length && hasTopics ? html`<button class="btn" data-act="new">出一套题</button>` : ''}
    </div>
    ${exams.length ? html`<ul class="panel list">${exams.map((e) => html`<li class="split">
      <a class="row row-link" href="#/c/${cid}/exam/${e.id}${e.status === 'finished' ? '/result' : ''}">
        <div class="grow"><div class="title">${e.title}</div>
          <div class="meta">${fmtDate(e.created_at)}${e.status === 'failed' ? '' : `，${e.question_count} 道题`}</div></div>
        ${e.status === 'finished'
          ? html`<span class="serif" style="font-size:17px;font-weight:600">${e.score}<span class="muted small"> / ${e.total} 分</span></span>`
          : e.status === 'failed' ? html`<span class="state bad">出题失败</span>`
          : e.status === 'generating' ? html`<span class="state run">出题中</span>`
          : html`<span class="state">做到 ${e.answered} / ${e.question_count}</span>`}
      </a>
      <button class="icon-btn" data-act="menu" data-eid="${e.id}" aria-label="${e.title}的更多操作">⋯</button></li>`)}</ul>`
    : hasTopics ? html`<div class="panel empty"><h2>做一套题检验一下</h2>
        <p>题目按你的计划和老师的重点出，每道题都标出处。做完会更新掌握情况，计划跟着调整。</p>
        <button class="btn" data-act="new">出一套题</button></div>`
    : html`<div class="panel empty"><h2>先上传资料</h2><p>题目从课件里整理出的知识点出。</p>
        <a class="btn" href="#/c/${cid}/materials">去上传资料</a></div>`}
  </div>`; };

  await load();
  render();

  bind(el, {
    menu: (b) => {
      const e = exams.find((x) => x.id === b.dataset.eid);
      const s = sheet({
        title: e.title,
        body: html`<p class="muted">${fmtDate(e.created_at)}，${progress(e)}</p>`,
        foot: html`<button class="btn ghost" data-act="del" style="color:var(--red)">删除这套</button>`,
        handlers: {
          del: async () => {
            s.close();
            const ok = await confirmSheet({
              title: '删除这套题？',
              text: e.answered ? '作答记录会一起删除，掌握情况按剩下的练习重算。删除后不能恢复。' : '删除后不能恢复。',
              ok: '删除', danger: true,
            });
            if (!ok) return;
            await api.deleteExam(e.id);
            toast('已删除这套题');
            await load(); render(); ctx.refreshShell();
          },
        },
      });
    },
    new: () => {
      let count = 10, scope = 'plan';
      const s = sheet({
        title: '出一套题',
        body: html`<div class="field"><span>题量</span>
            <div class="seg full" role="group" aria-label="题量">${[5, 10, 20].map((n) => html`<button data-act="count" data-v="${n}" aria-pressed="${n === count}">${n} 道</button>`)}</div></div>
          <div class="field"><span>范围</span>
            <div class="seg full" role="group" aria-label="范围">
              <button data-act="scope" data-v="plan" aria-pressed="true">计划里的必学</button>
              <button data-act="scope" data-v="all" aria-pressed="false">全部</button>
              <button data-act="scope" data-v="mistakes" aria-pressed="false" ${hasShaky ? '' : 'disabled title="还没有做错过的知识点"'}>错题相关</button>
            </div></div>`,
        foot: html`<button class="btn block" data-act="go">开始出题</button>`,
        handlers: {
          count: (b) => { count = +b.dataset.v; s.el.querySelectorAll('[data-act="count"]').forEach((x) => x.setAttribute('aria-pressed', x === b)); },
          scope: (b) => { scope = b.dataset.v; s.el.querySelectorAll('[data-act="scope"]').forEach((x) => x.setAttribute('aria-pressed', x === b)); },
          go: async () => {
            const e = await api.createExam(cid, { count, scope });
            s.close();
            ctx.go(`#/c/${cid}/exam/${e.id}`);
          },
        },
      });
    },
  });
}
