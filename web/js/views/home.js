// 课程列表
import { api } from '../api.js';
import { html, bind, sheet, toast, confirmSheet, fmtDate, todayISO } from '../ui.js';
import { stepDots } from '../labels.js';

export async function mount(el, ctx) {
  const render = async () => {
    const courses = await api.courses();
    el.innerHTML = html`<div class="page">
      <div class="page-head">
        <div><h1>我的课程</h1>${courses.length ? html`<p class="sub">按考试日期排，最近的在上面</p>` : ''}</div>
        ${courses.length ? html`<button class="btn" data-act="new">新建课程</button>` : ''}
      </div>
      ${courses.length ? html`<ul class="panel list">${courses.map((c) => html`<li class="course-li">
        <a class="course-row row-link" href="#/c/${c.id}">
          <div class="grow">
            <div class="name">${c.name}</div>
            <div class="date">${c.exam_date ? `${fmtDate(c.exam_date, { week: true })}考试` : '还没定考试日期'}</div>
            <div style="margin-top:8px">${stepDots(c.steps)}</div>
          </div>
          ${c.days_left != null ? html`<div class="left ${c.days_left <= 7 ? 'near' : ''}">
            ${c.days_left > 0 ? html`<b>${c.days_left}</b><span>天后考试</span>` : html`<b>${c.days_left === 0 ? '今天' : '已考'}</b>`}
          </div>` : ''}
        </a>
        <button class="icon-btn course-menu" data-act="menu" data-cid="${c.id}" aria-label="${c.name}：更多操作">⋯</button></li>`)}</ul>` : html`<div class="panel empty">
          <h2>先建一门要考的课</h2>
          <p>填上课程名和考试日期，再把课件传上来，就能排出复习计划、出模拟题。</p>
          <button class="btn" data-act="new">新建课程</button>
        </div>`}
    </div>`;
  };
  bind(el, {
    new: () => newCourse(ctx),
    menu: async (b) => courseMenu((await api.courses()).find((c) => c.id === b.dataset.cid)),
  });
  await render();

  function courseMenu(c) {
    const s = sheet({
      title: c.name,
      body: html`<form id="ec" class="sheet-body" data-act="save" data-on="submit">
        <label class="field"><span>课程名</span><input class="input" name="name" required maxlength="40" value="${c.name}" autocomplete="off"></label>
        <label class="field"><span>考试日期</span><input class="input" type="date" name="exam_date" value="${c.exam_date || ''}"></label>
      </form>`,
      foot: html`<button class="btn ghost" data-act="del" style="color:var(--red)">删除课程</button><button class="btn" type="submit" form="ec">保存</button>`,
      handlers: {
        save: async (form) => {
          const fd = new FormData(form);
          await api.updateCourse(c.id, { name: fd.get('name').trim(), exam_date: fd.get('exam_date') || null });
          s.close();
          toast('已保存');
          await render(); ctx.refreshShell();
        },
        del: async () => {
          s.close();
          const ok = await confirmSheet({
            title: `删除“${c.name}”？`,
            text: '这门课的资料、重点、计划、题目和助手对话会一起删除，不能恢复。',
            ok: '删除课程', danger: true,
          });
          if (!ok) return;
          await api.deleteCourse(c.id);
          toast(`已删除“${c.name}”`);
          await render(); ctx.refreshShell();
        },
      },
    });
  }
}

function newCourse(ctx) {
  const s = sheet({
    title: '新建课程',
    body: html`<form id="nc" class="sheet-body" data-act="create" data-on="submit">
      <label class="field"><span>课程名</span><input class="input" name="name" required maxlength="40" placeholder="例如：操作系统" autocomplete="off"></label>
      <label class="field"><span>考试日期（可以之后再填）</span><input class="input" type="date" name="exam_date" min="${todayISO()}"></label>
    </form>`,
    foot: html`<button class="btn block" type="submit" form="nc">新建课程</button>`,
    handlers: {
      create: async (form) => {
        const fd = new FormData(form);
        const c = await api.createCourse({ name: fd.get('name').trim(), exam_date: fd.get('exam_date') || null });
        s.close();
        ctx.go(`#/c/${c.id}/materials`);
      },
    },
  });
}
