// 重点：老师说了什么（映射到知识点，荧光笔标级别）+ 考试形式
import { api } from '../api.js';
import { html, bind, toast, pct } from '../ui.js';
import { QTYPE, LEVEL_CLASS, basisTag } from '../labels.js';

export async function mount(el, ctx) {
  const cid = ctx.course.id;
  let focus, format, draft, stopPoll = null, textDraft = null;
  let dirty = false;

  const load = async () => { [focus, format] = await Promise.all([api.focus(cid), api.examFormat(cid)]); if (!dirty) draft = structuredClone(format); };

  const ACTIVE = new Set(['queued', 'running']);   // 合同第 3 节：排队和运行中都要继续轮询
  const active = () => !!focus.job && ACTIVE.has(focus.job.status);
  const kpActive = (k) => (k.user_choice === null ? k.certainty === 'sure' : k.user_choice);

  const render = () => {
    const running = active();
    const queued = running && focus.job.status === 'queued';
    const text = textDraft ?? focus.text;
    const changed = text.trim() !== (focus.text || '').trim();
    el.innerHTML = html`<div class="page">
      <div class="page-head"><div><h1>重点</h1><p class="sub">老师怎么说的就怎么写，不用整理</p></div></div>

      <section class="section">
        <h2>老师说了什么</h2>
        <div class="panel pad" style="display:flex;flex-direction:column;gap:12px">
          <textarea class="textarea" data-act="text" data-on="input" placeholder="例如：银行家算法一定考大题。RAID 了解一下，不考。" aria-label="老师说的重点">${text}</textarea>
          ${running ? html`<div style="display:flex;flex-direction:column;gap:6px">
              <span class="state run">${focus.job.stage || (queued ? '排队中，马上开始' : '分析中')}${focus.job.progress != null ? ` ${pct(focus.job.progress)}` : ''}</span>
              <div class="bar ${focus.job.progress == null ? 'indet' : ''}"><i style="width:${pct(focus.job.progress)}"></i></div></div>`
            : focus.job?.status === 'failed' ? html`<div class="notice"><span class="grow">${focus.job.error?.message || '分析没有完成'}</span><button class="link" data-act="retry">重试</button></div>`
            : html`<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
              <span class="muted small">${focus.analyzed_at && !changed ? '已分析，改了内容后再分析一次' : '每句话会对应到课件里的知识点'}</span>
              <button class="btn" data-act="analyze" ${!text.trim() || (!changed && focus.analyzed_at) ? 'disabled' : ''}>分析重点</button></div>`}
        </div>

        ${focus.suggestions.map((s) => html`<div class="sugg">
          <div class="sugg-q">${s.title}</div>${s.detail ? html`<div class="muted small">${s.detail}</div>` : ''}
          <div class="sugg-opts">${s.options.map((o) => html`<button class="sugg-opt" aria-pressed="${o.id === s.default_option}" data-act="resolve" data-sid="${s.id}" data-choice="${o.id}">${o.label}</button>`)}</div>
        </div>`)}

        ${focus.fragments.length ? html`
          <div class="legend" aria-label="图例">
            <span><span class="hl emph">强调</span></span><span><span class="hl ment">提及</span></span>
            <span><span class="hl excl">不考</span></span><span><span class="kp maybe">可能也包括</span>，点一下加入或移除</span>
          </div>
          <div class="panel">${focus.fragments.map(frag)}</div>` : ''}
      </section>

      <section class="section">
        <div class="section-head"><h2>考试形式</h2>${basisTag(dirty ? 'user' : format.basis)}</div>
        <div class="panel">
          ${draft.types.map((t, i) => html`<div class="fmt-row ${t.count ? '' : 'zero'}">
            <span class="fmt-name">${QTYPE[t.type]}</span>
            <span class="stepper" role="group" aria-label="${QTYPE[t.type]}题量">
              <button data-act="cnt" data-i="${i}" data-d="-1" aria-label="减少">−</button>
              <input type="number" min="0" max="50" value="${t.count}" data-act="cntIn" data-i="${i}" aria-label="题量">
              <button data-act="cnt" data-i="${i}" data-d="1" aria-label="增加">＋</button>
            </span>
            <span class="per">每题 <input class="input" type="number" min="0" max="100" value="${t.score}" data-act="score" data-i="${i}" aria-label="每题分值"> 分</span>
          </div>`)}
          <div class="fmt-row">
            <span class="fmt-name">时长</span>
            <span class="per" style="justify-content:flex-start"><input class="input" type="number" min="0" max="600" value="${draft.duration_min ?? ''}" data-act="dur" aria-label="考试时长"> 分钟</span>
            <label class="per">开卷 <span class="switch"><input type="checkbox" ${draft.open_book ? 'checked' : ''} data-act="open"><span></span></span></label>
          </div>
          <div class="fmt-foot">
            <span class="muted small">共 ${draft.types.reduce((s, t) => s + t.count * t.score, 0)} 分${format.basis === 'default' && !dirty ? '，这是默认设置，按老师说的改一下更准' : ''}</span>
            ${dirty ? html`<span style="display:flex;gap:8px"><button class="btn ghost small" data-act="undoFmt">还原</button><button class="btn small" data-act="saveFmt">确认考试形式</button></span>` : ''}
          </div>
        </div>
      </section>
    </div>`;
  };

  const frag = (f) => html`<div class="frag">
    <div class="quote">${f.text}</div>
    ${f.found ? html`<div class="kps">${f.kps.map((k) => {
      const on = kpActive(k);
      return html`<button class="kp ${k.certainty === 'maybe' && k.user_choice !== true ? 'maybe' : ''} ${on ? '' : 'off'}"
        data-act="toggle" data-kp="${k.id}" data-on-state="${on}" aria-pressed="${on}" title="${on ? '点一下移除' : '点一下加入'}">
        <span class="hl ${on ? LEVEL_CLASS[k.level] : ''}">${k.title}</span></button>`;
    })}</div>` : html`<div class="nf">课件里没找到对应内容</div>`}
  </div>`;

  const ensurePoll = () => {
    if (active() && !stopPoll) {
      stopPoll = ctx.poll(async () => {
        focus = await api.focus(cid);
        if (!active()) {
          stopPoll(); stopPoll = null;
          if (!focus.job || focus.job.status === 'done') toast('重点已分析');
          ctx.refreshShell();
        }
        render();
      });
    }
  };

  bind(el, {
    text: (ta) => {
      textDraft = ta.value;
      const btn = el.querySelector('[data-act="analyze"]');
      if (btn) btn.disabled = !ta.value.trim() || (ta.value.trim() === (focus.text || '').trim() && !!focus.analyzed_at);
    },
    analyze: async () => {
      focus = await api.analyzeFocus(cid, textDraft ?? focus.text);
      textDraft = null;
      render(); ensurePoll(); ctx.refreshShell();
    },
    retry: async () => { await api.retryJob(focus.job.id); await load(); render(); ensurePoll(); ctx.refreshShell(); },
    toggle: async (b) => {
      const kid = b.dataset.kp;
      const wasOn = b.dataset.onState === 'true';
      const title = b.textContent.trim();
      focus = await api.setFocusKp(cid, kid, !wasOn);
      render();
      toast(wasOn ? `已移除“${title}”` : `已加入“${title}”`, {
        action: '撤销', onAction: async () => { focus = await api.setFocusKp(cid, kid, null); render(); },
      });
    },
    resolve: async (b) => {
      await api.answerSuggestion(b.dataset.sid, b.dataset.choice);
      await load(); render(); ctx.refreshShell();
    },
    cnt: (b) => { const t = draft.types[+b.dataset.i]; t.count = Math.max(0, Math.min(50, t.count + +b.dataset.d)); dirty = true; render(); },
    cntIn: (inp) => { draft.types[+inp.dataset.i].count = Math.max(0, Math.min(50, +inp.value || 0)); dirty = true; render(); },
    score: (inp) => { draft.types[+inp.dataset.i].score = Math.max(0, Math.min(100, +inp.value || 0)); dirty = true; render(); },
    dur: (inp) => { draft.duration_min = inp.value ? Math.max(0, +inp.value) : null; dirty = true; render(); },
    open: (cb) => { draft.open_book = cb.checked; dirty = true; render(); },
    undoFmt: () => { draft = structuredClone(format); dirty = false; render(); },
    saveFmt: async () => {
      const { basis, ...body } = draft;
      format = await api.saveExamFormat(cid, body);
      draft = structuredClone(format); dirty = false;
      render(); toast('考试形式已确认，之后出题按它来');
    },
  });

  await load(); render(); ensurePoll();
}
