// 作答（沉浸）：一次一题；客观题代码判分，主观题对照评分点自评；出处、提示、报错
import { api } from '../api.js';
import { html, bind, sheet, toast } from '../ui.js';
import { QTYPE, REPORT } from '../labels.js';
import { blocks, refTag, openPage } from './blocks.js';
import { setContext, show as showAssistant } from '../assistant.js';

const MARKS = [['full', '答到了'], ['partial', '部分'], ['none', '没答到']];

export async function mount(el, ctx) {
  const { cid, eid } = ctx.params;
  let exam = await api.exam(eid);
  let idx = 0;
  const drafts = {};      // qid → 作答草稿
  const marks = {};       // qid → { rubric id → full|partial|none }
  let stopPoll = null;
  let edits = 0;          // 本地改动计数：轮询结果若早于本地改动，就丢弃，避免覆盖刚提交的作答

  const generating = () => exam.status === 'generating' && !['done', 'failed'].includes(exam.job?.status);
  const jobError = () => exam.status !== 'finished' && exam.job?.status === 'failed' ? exam.job.error : null;
  const live = () => exam.questions.filter((q) => q.status !== 'hidden');
  const graded = (q) => q.attempt?.state === 'graded';
  const allDone = () => exam.status !== 'generating' && exam.questions.length > 0 && live().every(graded);
  const firstOpen = () => Math.max(0, exam.questions.findIndex((q) => q.status !== 'hidden' && !graded(q)));
  idx = exam.status === 'finished' ? 0 : firstOpen();

  const dotClass = (q, i) => {
    const c = [i === idx ? 'cur' : ''];
    if (q.status === 'hidden') c.push('gone');
    else if (q.status === 'generating' || q.status === 'verifying') c.push('wait');
    else if (graded(q)) c.push(q.attempt.score >= q.score ? 'ok' : q.attempt.score > 0 ? 'part' : 'bad');
    else if (q.attempt) c.push('part');
    return c.join(' ');
  };

  const render = () => {
    const q = exam.questions[idx];
    const failure = jobError();
    setContext({ view: 'exam', exam_id: eid, question_id: q && q.status !== 'generating' ? q.id : undefined });
    const done = live().filter(graded).length;
    el.innerHTML = html`
      <div class="exam-top">
        <div class="bar1">
          <button class="icon-btn" data-act="exit" aria-label="退出作答">✕</button>
          <div class="t">${exam.title}</div>
          <div class="p">${generating() ? '出题中，' : ''}已答 ${done} / ${live().length}</div>
          <button class="btn ghost small" data-act="ask">问助手</button>
        </div>
        <div class="dots" role="tablist" aria-label="题号">${exam.questions.map((x, i) => html`<button class="dot ${dotClass(x, i)}" data-act="jump" data-i="${i}" aria-label="第 ${i + 1} 题" aria-selected="${i === idx}">${i + 1}</button>`)}</div>
      </div>
      <div style="padding:16px">
        ${exam.format_basis === 'default' ? html`<p class="muted small" style="margin:0 4px 12px">题型分布为默认设置，未必与真实考试一致</p>` : ''}
        ${failure ? html`<div class="notice" role="status">
          <span class="grow">${failure.message}</span>
          ${failure.retryable ? html`<button class="link" data-act="retry">重试</button>` : ''}
        </div>` : exam.job?.status === 'done' && exam.job.stage?.includes('有限') ? html`<p class="muted small">${exam.job.stage}</p>` : ''}
        ${q ? html`<article class="panel q" aria-live="polite">${question(q)}</article>` : ''}
      </div>
      <div class="exam-actions"><div class="in">
        <button class="btn ghost nav" data-act="prev" aria-label="上一题" ${idx === 0 ? 'disabled' : ''}>‹</button>
        ${primary(q)}
        <button class="btn ghost nav" data-act="next" aria-label="下一题" ${idx >= exam.questions.length - 1 ? 'disabled' : ''}>›</button>
      </div></div>`;
  };

  const primary = (q) => {
    if (exam.status === 'finished') return html`<a class="btn" href="#/c/${cid}/exam/${eid}/result">查看结果</a>`;
    if (!q || q.status === 'generating' || q.status === 'verifying') {
      if (jobError() && !live().some((item) => item.status === 'ready' || item.status === 'disputed')) {
        return html`<a class="btn" href="#/c/${cid}/practice">返回练习</a>`;
      }
      if (jobError()) return nextOrFinish();
      return html`<button class="btn" disabled>${q?.status === 'verifying' ? '验证完就能作答' : '出题中…'}</button>`;
    }
    if (q.status === 'hidden') return nextOrFinish();
    if (!q.attempt) {
      const d = drafts[q.id];
      if (q.type === 'single') return html`<button class="btn" data-act="submit" ${d ? '' : 'disabled'}>提交</button>`;
      if (q.type === 'fill') return html`<button class="btn" data-act="submit" ${d?.trim() ? '' : 'disabled'}>提交</button>`;
      if (q.type === 'calc') return html`<button class="btn" data-act="submit">提交并看解析</button>`;
      return html`<button class="btn" data-act="submit">看解析并自评</button>`;
    }
    if (q.attempt.state === 'needs_self_grade') {
      const m = marks[q.id] || {};
      const ready = (q.solution.rubric || []).every((r) => m[r.id]);
      return html`<button class="btn" data-act="grade" ${ready ? '' : 'disabled'}>确认得分</button>`;
    }
    return nextOrFinish();
  };
  const nextOrFinish = () => (allDone()
    ? html`<button class="btn" data-act="finish">完成本套</button>`
    : html`<button class="btn" data-act="nextOpen">下一题</button>`);

  const question = (q) => {
    const head = html`<div class="q-head"><div class="grow">
        <div class="q-no">第 ${q.index} 题<span>${QTYPE[q.type]}，${q.score} 分</span></div>
        <div class="q-topic">${q.topic_title}</div></div>
      ${q.status !== 'generating' && q.status !== 'hidden' && exam.status !== 'finished' ? html`<button class="icon-btn" data-act="report" aria-label="报错" title="这道题有问题">⚑</button>` : ''}</div>`;
    if (q.status === 'generating' || (q.status === 'verifying' && !q.stem.length)) {
      if (jobError()) return html`${head}<p class="muted">这道题还没出好。</p>`;
      const status = q.status === 'verifying' ? '验证中' : '出题中';
      return html`${head}<div class="skeleton" aria-label="${status}"><i style="width:92%"></i><i style="width:76%"></i><i style="width:84%"></i></div>
        <p class="muted small">${status}。可以先做其他题。</p>`;
    }
    if (q.status === 'hidden') return html`${head}<p class="muted">已记录报错，这道题已隐藏，不计分。</p>`;

    const tags = html`<div class="tags">
      ${q.refs.map(refTag)}
      ${q.status === 'verifying' ? html`<span class="tag pen">验证中</span>` : ''}
      ${q.status === 'disputed' ? html`<span class="tag red">有争议</span>` : ''}
      ${q.hints.map((h) => html`<span class="tag amber">${h}</span>`)}
      ${q.checked ? '' : html`<span class="tag amber">未经检查</span>`}
      ${q.peeked ? html`<span class="tag">看过答案</span>` : ''}
    </div>`;
    return html`${head}<div class="stem">${blocks(q.stem)}</div>${answerArea(q)}${tags}${q.attempt ? solution(q) : ''}`;
  };

  const answerArea = (q) => {
    const a = q.attempt;
    const locked = !!a || q.status === 'verifying' || exam.status === 'finished';
    if (q.type === 'single') {
      const pick = a ? a.response : drafts[q.id];
      const key = q.solution?.answer;
      return html`<div class="opts" role="radiogroup">${q.options.map((o) => {
        let cls = '';
        if (a) { if (o.id === key) cls = 'right'; else if (o.id === pick) cls = 'wrong'; }
        return html`<button class="opt-btn ${cls}" role="radio" aria-checked="${o.id === pick}" aria-pressed="${!a && o.id === pick}" data-act="pick" data-v="${o.id}" ${locked ? 'disabled' : ''}>
          <span class="k">${o.id}</span><span>${o.text}</span></button>`;
      })}</div>${a ? verdict(q) : ''}`;
    }
    if (q.type === 'fill' || q.type === 'calc') {
      return html`<label class="field"><span>${q.type === 'fill' ? '你的答案' : '最终答案（可以不填）'}</span>
        <input class="input" data-act="draft" data-on="input" value="${a ? a.response || '' : drafts[q.id] || ''}" ${locked ? 'disabled' : ''} autocomplete="off" placeholder="${q.type === 'fill' ? '填数字或简短的词' : ''}"></label>${a ? verdict(q) : ''}`;
    }
    return html`<label class="field"><span>你的答案（可以不写，直接看解析自评）</span>
      <textarea class="textarea" data-act="draft" data-on="input" ${locked ? 'disabled' : ''}>${a ? a.response || '' : drafts[q.id] || ''}</textarea></label>${a ? verdict(q) : ''}`;
  };

  const verdict = (q) => {
    const a = q.attempt;
    if (a.state === 'needs_self_grade') {
      const calcNote = q.type === 'calc' && a.correct != null ? (a.correct ? '最终答案对了，' : '最终答案和参考答案不同，') : '';
      return html`<div class="verdict self">${calcNote}对照下面的评分点给自己打分</div>`;
    }
    const cls = a.score >= q.score ? 'ok' : a.score > 0 ? 'part' : 'bad';
    const word = cls === 'ok' ? '答对了' : cls === 'part' ? '部分得分' : '答错了';
    return html`<div class="verdict ${cls}">${word}<span class="s">${a.score} / ${q.score} 分</span></div>`;
  };

  const solution = (q) => {
    const s = q.solution;
    const m = q.attempt.marks || marks[q.id] || {};
    const editing = q.attempt.state === 'needs_self_grade';
    const total = (s.rubric || []).reduce((t, r) => t + (m[r.id] === 'full' ? r.score : m[r.id] === 'partial' ? r.score / 2 : 0), 0);
    return html`<div class="sol">
      <div class="sol-ans"><span>参考答案</span>${s.answer}</div>
      <ol class="steps-sol" style="margin:0;padding:0;list-style:none">${s.steps.map((st) => html`<li><span class="n">${st.n}</span>
        <div class="c">${blocks(st.blocks)}${st.refs.length ? html`<div class="tags">${st.refs.map(refTag)}</div>` : ''}</div></li>`)}</ol>
      ${s.rubric ? html`<div class="panel pad" style="background:#FAFBFD">
        <div class="rubric">${s.rubric.map((r) => html`<div class="rub">
          <div class="pt"><span class="grow">${r.point}</span><span class="sc">${r.score} 分</span></div>
          <div class="seg" role="group" aria-label="${r.point}">${MARKS.map(([k, label]) => html`<button data-act="mark" data-r="${r.id}" data-v="${k}" aria-pressed="${m[r.id] === k}" ${editing ? '' : 'disabled'}>${label}</button>`)}</div>
        </div>`)}</div>
        <div class="rub-total"><span>${editing ? '自评得分' : '得分'}</span><span class="serif">${editing ? total : q.attempt.score} / ${q.score}</span></div>
      </div>` : ''}
    </div>`;
  };

  const setExam = (fresh) => {
    const currentId = exam.questions[idx]?.id;
    exam = fresh;
    const index = exam.questions.findIndex((q) => q.id === currentId);
    idx = index < 0 ? firstOpen() : index;
  };
  const refresh = async () => { setExam(await api.exam(eid)); render(); };
  const snapshot = () => [exam.status, exam.job?.status, ...exam.questions.map((q) => `${q.id}:${q.status}`)].join();
  const ensurePoll = () => {
    if (generating() && !stopPoll) {
      stopPoll = ctx.poll(async () => {
        const before = snapshot();
        const seen = edits;
        const fresh = await api.exam(eid);
        if (seen !== edits) return;
        setExam(fresh);
        if (snapshot() !== before) {
          const active = document.activeElement;
          const keep = active?.matches('input, textarea') ? { v: active.value, s: active.selectionStart } : null;
          render();
          if (keep) { const f = el.querySelector('.q input, .q textarea'); if (f) { f.focus(); f.setSelectionRange?.(keep.s, keep.s); } }
        }
        if (!generating()) { stopPoll(); stopPoll = null; }
      });
    }
  };

  const go = (i) => { idx = Math.max(0, Math.min(exam.questions.length - 1, i)); render(); el.querySelector('.exam-top')?.scrollIntoView({ block: 'start' }); };

  bind(el, {
    exit: () => ctx.go(`#/c/${cid}/practice`),
    retry: async (button) => {
      button.disabled = true;
      edits++;
      try {
        await api.retryJob(exam.job.id);
        await refresh();
        ensurePoll();
      } finally {
        button.disabled = false;
      }
    },
    jump: (b) => go(+b.dataset.i),
    prev: () => go(idx - 1),
    next: () => go(idx + 1),
    nextOpen: () => {
      const n = exam.questions.length;
      for (let k = 1; k <= n; k++) {
        const j = (idx + k) % n, q = exam.questions[j];
        if (q.status !== 'hidden' && !graded(q)) return go(j);
      }
      go(idx + 1);
    },
    pick: (b) => { drafts[exam.questions[idx].id] = b.dataset.v; render(); },
    draft: (inp) => {
      drafts[exam.questions[idx].id] = inp.value;
      const btn = el.querySelector('[data-act="submit"]');
      if (btn && exam.questions[idx].type === 'fill') btn.disabled = !inp.value.trim();
    },
    submit: async () => {
      const q = exam.questions[idx];
      edits++;
      const r = await api.attempt(q.id, drafts[q.id] ?? null);
      Object.assign(q, { attempt: r.attempt, solution: r.solution });
      edits++;
      render();
      announce(r.mastery_changes);
    },
    mark: (b) => {
      const q = exam.questions[idx];
      (marks[q.id] ||= {})[b.dataset.r] = b.dataset.v;
      const y = window.scrollY; render(); window.scrollTo(0, y);
    },
    grade: async () => {
      const q = exam.questions[idx];
      edits++;
      const r = await api.grade(q.id, marks[q.id]);
      Object.assign(q, { attempt: r.attempt, solution: r.solution });
      edits++;
      const y = window.scrollY; render(); window.scrollTo(0, y);
      announce(r.mastery_changes);
    },
    finish: async () => {
      await api.finishExam(eid);
      ctx.go(`#/c/${cid}/exam/${eid}/result`);
    },
    report: () => reportSheet(exam.questions[idx]),
    ref: (b) => openPage(b.dataset.mid, +b.dataset.page, b.textContent),
    ask: () => showAssistant(),
  });

  const announce = (changes = []) => {
    const up = changes.filter((c) => c.to === 'mastered');
    if (up.length) toast(`“${up[0].title}”已掌握`);
  };

  function reportSheet(q) {
    let kind = null;
    const s = sheet({
      title: '这道题有问题',
      body: html`<div class="tags" role="radiogroup" aria-label="问题类型" style="gap:8px">${REPORT.map(([k, label]) => html`<button class="sugg-opt" data-act="kind" data-v="${k}" aria-pressed="false">${label}</button>`)}</div>
        <label class="field"><span>说一句哪里不对（可选，写得越具体越容易查清）</span>
          <textarea class="textarea" style="min-height:88px" id="rnote" placeholder="例如：第 2 步的定义和课件第 58 页不一样"></textarea></label>`,
      foot: html`<button class="btn block" data-act="send" disabled>提交报错</button>`,
      handlers: {
        kind: (b) => {
          kind = b.dataset.v;
          s.el.querySelectorAll('[data-act="kind"]').forEach((x) => x.setAttribute('aria-pressed', x === b));
          s.el.querySelector('[data-act="send"]').disabled = false;
        },
        send: async () => {
          edits++;
          await api.report(q.id, kind, s.el.querySelector('#rnote').value.trim());
          s.close();
          q.status = 'hidden';
          toast('已记录报错，这道题已隐藏');
          await refresh();
        },
      },
    });
  }

  const onKey = (e) => {
    if (document.querySelector('.scrim') || e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft') go(idx - 1);
    if (e.key === 'ArrowRight') go(idx + 1);
  };
  document.addEventListener('keydown', onKey);
  const onData = (e) => { if (e.detail.affects.includes('exam')) { edits++; refresh(); } };
  window.addEventListener('data-changed', onData);
  ctx.onLeave(() => { document.removeEventListener('keydown', onKey); window.removeEventListener('data-changed', onData); });

  render(); ensurePoll();
}
