// 资料：上传、处理状态、版本与资料角色的建议卡
import { api } from '../api.js';
import { html, bind, sheet, toast, confirmSheet, pct } from '../ui.js';
import { KIND } from '../labels.js';

const ACCEPT = '.pdf,.ppt,.pptx,.doc,.docx,.txt,.md';
const busy = (m) => m.status === 'reading' || m.status === 'extracting';

export async function mount(el, ctx) {
  const cid = ctx.course.id;
  let data = { materials: [], suggestions: [] };
  let showAllSugg = false;
  let stopPoll = null;
  let batch = new Set();        // 这一批等待结果的资料 id；全部有结果时提示一次
  const retrying = new Set();   // 点了“重试”、还没结束的 Job id
  const replacing = new Map();  // 替代资料 id → 被替代的失败资料 id；替代资料 ready 后才删旧的
  const JOBS_KEY = `examprep-upload-jobs-${cid}`;
  let jobOf = new Map();        // 资料 id → 上传时的 Job id，用于“重试”
  try { jobOf = new Map(JSON.parse(sessionStorage.getItem(JOBS_KEY) || '[]')); } catch { /* 存储不可用就只记在内存里 */ }
  const rememberJob = (ids, jobId) => {
    for (const id of ids) jobOf.set(id, jobId);
    try { sessionStorage.setItem(JOBS_KEY, JSON.stringify([...jobOf])); } catch { /* 同上 */ }
  };

  const load = async () => { data = await api.materials(cid); };

  const render = () => {
    const live = data.materials.filter((m) => !m.superseded_by);
    const old = data.materials.filter((m) => m.superseded_by);
    const sugg = showAllSugg ? data.suggestions : data.suggestions.slice(0, 2);
    const hidden = data.suggestions.length - sugg.length;
    el.innerHTML = html`<div class="page">
      <div class="page-head">
        <div><h1>资料</h1><p class="sub">${live.length ? `${live.length} 份在用${old.length ? `，${old.length} 份旧版本` : ''}` : '课件、作业、笔记、老师的复习材料都可以'}</p></div>
        ${live.length ? html`<label class="btn" tabindex="0" data-act="pick" data-on="keydown">上传资料<input type="file" multiple accept="${ACCEPT}" hidden data-act="files"></label>` : ''}
      </div>

      ${sugg.length ? html`<div class="section">${sugg.map(suggCard)}
        ${hidden > 0 ? html`<button class="link" data-act="moreSugg">还有 ${hidden} 项待确认</button>` : ''}</div>` : ''}

      <div class="drop" id="drop">
        ${live.length ? html`<ul class="panel list">${live.map(row)}</ul>
          ${old.length ? html`<details class="panel fold" style="margin-top:12px"><summary>旧版本（${old.length}）</summary>
            <ul class="list">${old.map(row)}</ul></details>` : ''}`
        : html`<div class="panel empty">
            <h2>把这门课的资料传上来</h2>
            <p>支持 PDF、PPT、Word、TXT 和 Markdown，可以一次选多份。电脑上也可以直接拖到这里。</p>
            <label class="btn" tabindex="0">上传资料<input type="file" multiple accept="${ACCEPT}" hidden data-act="files"></label>
          </div>`}
      </div>
    </div>`;
  };

  const suggCard = (s) => html`<div class="sugg">
    <div class="sugg-q">${s.title}</div>
    ${s.detail ? html`<div class="muted small">${s.detail}</div>` : ''}
    <div class="sugg-opts">${s.options.map((o) => html`<button class="sugg-opt" aria-pressed="${o.id === s.default_option}" data-act="answer" data-sid="${s.id}" data-choice="${o.id}">${o.label}</button>`)}</div>
    <div class="sugg-hint">不选也行，已按高亮的选项处理</div>
  </div>`;

  const row = (m) => html`<li><div class="row">
    <div class="grow">
      <div class="title">${m.title}</div>
      ${status(m)}
    </div>
    <span class="tag">${KIND[m.kind] || m.kind}</span>
    <button class="icon-btn" data-act="menu" data-mid="${m.id}" aria-label="更多操作">⋯</button>
  </div></li>`;

  const status = (m) => {
    if (busy(m)) return html`<div class="meta" style="display:flex;flex-direction:column;gap:6px">
      <span class="state run">${m.stage || '处理中'} ${m.progress != null ? pct(m.progress) : ''}</span>
      <div class="bar"><i style="width:${pct(m.progress)}"></i></div></div>`;
    if (m.status === 'failed') return html`<div class="meta fail-meta">
      <span class="state bad">读取失败：${m.error?.message || '文件没能读出内容'}</span>
      ${m.error?.retryable && jobOf.has(m.id)
        ? html`<button class="link reupload" data-act="retry" data-mid="${m.id}">重试</button>`
        : html`<label class="link reupload" tabindex="0" data-act="pick" data-on="keydown">重新上传<input type="file" accept="${ACCEPT}" hidden data-act="replace" data-mid="${m.id}"></label>`}
    </div>`;
    const bits = [];
    if (m.pages) bits.push(`${m.pages} 页`);
    if (m.kp_count != null) bits.push(`${m.kp_count} 个知识点`);
    return html`<div class="meta">${bits.join('，')}${m.vision === 'partial' ? html`<span class="state" style="margin-left:10px">图示补充中</span>` : ''}${m.vision === 'unsupported' ? html`<span class="state warn" style="margin-left:10px">图示未解析</span>` : ''}</div>`;
  };

  // 首次加载、每次轮询、上传和重试之后都走这一段：结算批次、处理替代、决定要不要继续轮询
  let queue = Promise.resolve();
  const refresh = () => (queue = queue.then(doRefresh, doRefresh));   // 串行：轮询和手动刷新不会同时结算，避免重复提示
  const doRefresh = async () => {
    await load();
    for (const m of data.materials) if (busy(m)) batch.add(m.id);
    for (const jobId of [...retrying]) {
      const j = await api.job(jobId);
      if (j.status === 'done' || j.status === 'failed') retrying.delete(jobId);
    }
    for (const [newId, oldId] of [...replacing]) {
      const n = data.materials.find((m) => m.id === newId);
      if (n?.status === 'ready') { replacing.delete(newId); await api.deleteMaterial(oldId); await load(); }
      else if (!n || n.status === 'failed') replacing.delete(newId);   // 替代失败：旧记录留着
    }
    render();
    const mine = data.materials.filter((m) => batch.has(m.id));
    if (batch.size && !mine.some(busy) && !retrying.size) {
      batch = new Set();
      if (mine.length) batchDone(mine);
    }
    const active = data.materials.some((m) => busy(m) || m.vision === 'partial') || retrying.size > 0 || replacing.size > 0;
    if (active && !stopPoll) stopPoll = ctx.poll(refresh);
    if (!active && stopPoll) { stopPoll(); stopPoll = null; }
  };

  // 设计 §3 第 7 条：按实际结果提示，失败的不能说成“整理好了”
  const batchDone = (mine) => {
    const ok = mine.filter((m) => m.status === 'ready').length;
    const bad = mine.filter((m) => m.status === 'failed').length;
    if (!bad) toast(ok > 1 ? `资料整理好了，共 ${ok} 份` : '资料整理好了');
    else if (!ok) toast(`${bad} 份读取失败，可以换一份重新上传`, { tone: 'error' });
    else toast(`已整理 ${ok} 份，${bad} 份读取失败`, { tone: 'error' });
    ctx.refreshShell();
  };

  const upload = async (files) => {
    if (!files.length) return null;
    const r = await api.upload(cid, files);
    for (const m of r.materials) batch.add(m.id);
    rememberJob(r.materials.map((m) => m.id), r.job.id);
    toast(`已上传 ${r.materials.length} 份，正在整理`);
    ctx.refreshShell();
    await refresh();
    return r;
  };

  bind(el, {
    files: (input) => upload([...input.files]),
    // 坏文件“重新上传”：替代资料整理成功（ready）后才删掉旧的失败记录
    replace: async (input) => {
      const failedId = input.dataset.mid;
      const files = [...input.files];
      if (!files.length) return;
      const r = await api.upload(cid, files);
      for (const m of r.materials) { batch.add(m.id); replacing.set(m.id, failedId); }
      rememberJob(r.materials.map((m) => m.id), r.job.id);
      toast('已重新上传，正在整理');
      await refresh();
    },
    // 可重试的失败：继续原来的 Job，资料 id 不变
    retry: async (b) => {
      const jobId = jobOf.get(b.dataset.mid);
      await api.retryJob(jobId);
      retrying.add(jobId);
      batch.add(b.dataset.mid);
      toast('正在重试');
      await refresh();
    },
    pick: (lbl, e) => { if (e.key === 'Enter' || e.key === ' ') lbl.querySelector('input').click(); },
    moreSugg: () => { showAllSugg = true; render(); },
    answer: async (b) => {
      const s = data.suggestions.find((x) => x.id === b.dataset.sid);
      const choice = s.options.find((o) => o.id === b.dataset.choice);
      await api.answerSuggestion(b.dataset.sid, b.dataset.choice);
      toast(`已按“${choice.label}”处理`);
      await load(); render(); ctx.refreshShell();
    },
    menu: (b) => menu(data.materials.find((m) => m.id === b.dataset.mid)),
  });

  function menu(m) {
    const s = sheet({
      title: m.title,
      body: html`<label class="field"><span>资料类型</span>
        <select class="select" data-act="kind">${Object.entries(KIND).map(([k, v]) => html`<option value="${k}" ${k === m.kind ? 'selected' : ''}>${v}</option>`)}</select></label>
        <p class="muted small">类型决定它在计划里的作用：复习题讲义和往年卷会作为老师重点的依据。</p>`,
      foot: html`<button class="btn ghost" data-act="del" style="color:var(--red)">删除资料</button>`,
      handlers: {
        kind: async (sel) => { await api.updateMaterial(m.id, { kind: sel.value }); toast(`已改为“${KIND[sel.value]}”`); await load(); render(); },
        del: async () => {
          s.close();
          const ok = await confirmSheet({ title: '删除这份资料？', text: '由它整理出的知识点和题目会一起删除，计划需要重排。删除后不能恢复。', ok: '删除资料', danger: true });
          if (!ok) return;
          await api.deleteMaterial(m.id);
          toast('资料已删除');
          await load(); render(); ctx.refreshShell();
        },
      },
    });
  }

  // 拖放上传（宽屏）
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.querySelector('#drop')?.classList.add('over'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.querySelector('#drop')?.classList.remove('over'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); el.querySelector('#drop')?.classList.remove('over'); upload([...e.dataTransfer.files]).catch((err) => toast(err.message, { tone: 'error' })); });

  await refresh();
}
