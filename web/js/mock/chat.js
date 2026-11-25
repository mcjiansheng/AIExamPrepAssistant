// 演示版备考助手：用关键词规则模拟意图识别，按 docs/接口合同/api-v0.md 第 10 节输出事件流。
// 真实后端由模型理解意图、调用工具；这里只用来让前端完整走通和演示交互。

import { internal as X, registerRoutes } from './server.js';
import { EXPLAIN } from './data.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPLAIN_TOPIC = { 银行家算法: '死锁', '信号量与 PV 操作': '进程同步与 PV 操作', 死锁的必要条件: '死锁', 页面置换算法: '虚拟存储与页面置换', 磁盘调度算法: '磁盘调度', SPOOLing: 'SPOOLing 与缓冲' };
const QTYPE_WORDS = [['single', /(?:选择|单选)题?/], ['fill', /填空题?/], ['calc', /(?:计算|大)题/], ['short', /(?:简答|问答)题?/], ['proof', /证明题?/], ['design', /设计题?/]];
const QTYPE_NAME = { single: '单选', fill: '填空', calc: '计算', short: '简答', proof: '证明', design: '设计' };

const chats = () => (X.S.chats ||= {});
const actions = () => (X.S.chatActions ||= {});
const proposals = () => (X.S.proposals ||= {});

function findTopic(course, text) {
  for (const ch of course.chapters) for (const t of ch.topics) {
    if (text.includes(t.title)) return t;
    if (t.kp_ids.some((k) => text.includes(course.kps[k].title))) return t;
  }
  const ex = EXPLAIN.find((e) => e.keys.some((k) => text.toUpperCase().includes(k.toUpperCase())));
  if (ex) for (const ch of course.chapters) for (const t of ch.topics) if (t.title === EXPLAIN_TOPIC[ex.title]) return t;
  return null;
}
const refOf = ([mid, page]) => {
  const m = X.S.materials[mid];
  return m ? { material_id: mid, material_title: m.title, page, quote: null } : null;
};

/** 流式回答。onEvent 收到的事件与真实后端的 NDJSON 每行相同 */
export async function mockChat(cid, body, onEvent) {
  X.tick();
  const course = X.getCourse(cid);
  const text = String(body?.text || '').trim();
  const ctx = body?.context || {};
  const list = (chats()[cid] ||= []);
  list.push({ id: X.id('msg'), role: 'user', text, created_at: X.iso(), tools: [], refs: [], actions: [], proposals: [] });
  const msg = { id: X.id('msg'), role: 'assistant', text: '', created_at: X.iso(), tools: [], refs: [], actions: [], proposals: [] };

  const emit = async (ev) => {
    if (ev.type === 'text') msg.text += ev.delta;
    if (ev.type === 'tool' && ev.status === 'done') msg.tools.push({ label: ev.label });
    if (ev.type === 'refs') msg.refs.push(...ev.refs);
    if (ev.type === 'action') msg.actions.push(ev.action);
    if (ev.type === 'proposal') msg.proposals.push(ev.proposal);
    onEvent(X.clone(ev));
  };
  const say = async (s) => {
    for (let i = 0; i < s.length; i += 6) { await emit({ type: 'text', delta: s.slice(i, i + 6) }); await sleep(18); }
  };
  const tool = async (label, ms = 600, fn) => {
    const tid = X.id('t');
    await emit({ type: 'tool', id: tid, label, status: 'running' });
    await sleep(ms);
    const out = fn ? await fn() : null;
    await emit({ type: 'tool', id: tid, label, status: 'done' });
    return out;
  };
  const act = async (kind, summary, href, affects, undo) => {
    const a = { id: X.id('a'), kind, summary, href, undoable: !!undo, undone: false, affects };
    actions()[a.id] = { cid, msg_id: msg.id, undo };
    await emit({ type: 'action', action: a });
  };

  await sleep(250);
  try {
    await respond();
    list.push(msg);
    X.save();
    await emit({ type: 'done', message_id: msg.id });
  } catch (err) {
    list.push(msg);
    X.save();
    await emit({ type: 'error', message: err.message || '助手这次没有回答完', retryable: true });
  }

  async function respond() {
    const hasKnowledge = course.chapters.length > 0;
    const q = ctx.question_id ? X.getQuestion(ctx.question_id).q : null;

    // 做题时问这道题：先给思路，明确要答案才给；问别的（重排计划、出题……）照常走下面的意图
    const aboutQuestion = /(这题|这道|怎么想|思路|提示|不会|怎么做|为什么|答案|选什么|选哪|解析|直接告诉|直接说)/.test(text);
    if (q && aboutQuestion && q.status !== 'generating' && q.status !== 'hidden') {
      const wantsAnswer = /(答案|选什么|选哪|直接告诉|直接说|给我解析|看解析)/.test(text);
      if (!q.attempt && !wantsAnswer) {
        await tool(`查课件：${q.topic_title}`, 500);
        await say(`先不告诉你答案，给个思路：\n\n${q._hint || '先找出题目考的是哪个概念，再回到课件里它的定义。'}\n\n还是没有头绪的话，说“告诉我答案”，我再讲完整解法。`);
        if (q.refs.length) await emit({ type: 'refs', refs: q.refs.map((r) => ({ ...r, quote: null })) });
        return;
      }
      if (!q.attempt && wantsAnswer) {
        q.peeked = true;
        await act('reveal', `第 ${q.index} 题已标为“看过答案”，答对也不计为做对`, null, ['exam'], null);
      }
      await say(`参考答案：${q.solution.answer}\n\n`);
      const first = q.solution.steps.map((st, i) => `${i + 1}. ${st.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join(' ')}`).join('\n');
      await say(`解法：\n${first}`);
      if (q.refs.length) await emit({ type: 'refs', refs: q.refs.map((r) => ({ ...r, quote: null })) });
      return;
    }

    if (!hasKnowledge && !/老师/.test(text)) {
      await say('这门课还没有资料。先在“资料”页上传课件，整理出知识点后，我就能讲解、排计划和出题了。');
      return;
    }

    // 重排计划：“只剩 3 天，每天 2 小时”
    const days = text.match(/(\d+)\s*天/);
    const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:个)?(?:小时|h)/i);
    if (days || (hours && /每天|一天/.test(text))) {
      const prev = course.plan ? { ...course.plan, pins: { ...course.plan.pins }, done: { ...course.plan.done } } : null;
      const d = Math.min(60, Math.max(1, +(days?.[1] ?? prev?.days ?? 7)));
      const h = Math.min(16, Math.max(0.5, +(hours?.[1] ?? prev?.hours_per_day ?? 3)));
      const plan = await tool('重排计划', 500, () => {
        course.plan = { id: prev?.id || X.id('p'), days: d, hours_per_day: h, start_date: new Date().toISOString().slice(0, 10), pins: prev?.pins || {}, done: prev?.done || {}, stale: false };
        return X.computePlan(course);
      });
      await act('replan', `已重排计划：${d} 天，每天 ${h} 小时`, `#/c/${cid}/plan`, ['plan'], { kind: 'replan', prev });
      const must = plan.buckets.must.length, drop = plan.buckets.drop;
      await say(`排好了。必学 ${must} 个主题，${plan.buckets.maybe.length} 个放在“有时间再学”。`);
      if (drop.length) await say(`这次放弃：${drop.map((t) => `${t.title}（${t.reasons[0]}）`).join('、')}。`);
      await say('\n\n想保住哪个主题，跟我说“固定某某”就行。');
      return;
    }

    // 固定 / 放弃主题
    const pinWord = text.match(/(固定|必学|一定要学|放弃|不学了?|不看了?)/);
    if (pinWord && course.plan) {
      const t = findTopic(course, text);
      if (t) {
        const pin = /(放弃|不学|不看)/.test(pinWord[1]) ? 'drop' : 'must';
        const prev = course.plan.pins[t.id] || null;
        await tool('更新计划', 400, () => { course.plan.pins[t.id] = pin; });
        await act('pin', pin === 'must' ? `已把“${t.title}”固定为必学` : `已放弃“${t.title}”`, `#/c/${cid}/plan`, ['plan'], { kind: 'pin', topic_id: t.id, prev });
        await say(pin === 'must' ? `好，“${t.title}”不会被重排挤掉了。为了腾出时间，计划里排在最后的主题可能会移到“有时间再学”。` : `好，这次不安排“${t.title}”。之后想捡回来，撤销就行。`);
        return;
      }
    }

    // 考试形式：只提议，确认后生效
    const counts = [];
    for (const [type, re] of QTYPE_WORDS) {
      const m = text.match(new RegExp(`(\\d+)\\s*道\\s*${re.source}`)) || text.match(new RegExp(`${re.source}\\s*(\\d+)\\s*道`));
      if (m) counts.push([type, +m[1]]);
    }
    if (counts.length && /(考试|期末|期中|卷|题型)/.test(text)) {
      const fmt = course.format;
      const next = X.clone(fmt);
      for (const t of next.types) { const c = counts.find(([k]) => k === t.type); t.count = c ? c[1] : 0; }
      const changes = next.types.filter((t, i) => t.count !== fmt.types[i].count).map((t, i) => ({ label: QTYPE_NAME[t.type], from: `${fmt.types.find((x) => x.type === t.type).count} 道`, to: `${t.count} 道` }));
      const p = { id: X.id('pp'), kind: 'exam_format', summary: '按你说的修改考试形式', changes, status: 'pending' };
      proposals()[p.id] = { cid, msg_id: msg.id, apply: { kind: 'exam_format', types: next.types } };
      await say('我按你说的整理了考试形式。确认后，之后出题按它来：');
      await emit({ type: 'proposal', proposal: p });
      return;
    }

    // 记录老师的重点
    if (/老师/.test(text) && /(说|讲|提到|划|强调|要求|考)/.test(text)) {
      const sentence = text.replace(/^(帮我)?(记一下|记下|记录一下)?[，,：:]?\s*/, '');
      const prev = { text: course.focus.text, fragments: course.focus.fragments, choices: course.focus.choices, analyzed_at: course.focus.analyzed_at };
      await tool('记录老师的重点', 400, () => {
        course.focus.text = (course.focus.text ? course.focus.text.replace(/[。\s]*$/, '。') : '') + sentence.replace(/^老师(今天)?(说|讲|提到)?[了：:，,]?/, '');
        const j = X.newJob('focus', cid, 3800, ['把每句话对应到主题', '在主题里选出知识点', '多次选择取多数']);
        course.focus.job_id = j.id;
      });
      await act('focus_add', '已记进老师的重点，正在对应到知识点', `#/c/${cid}/focus`, ['focus', 'plan'], { kind: 'focus', prev });
      await say('记下了。分析完以后，计划会提示你重排；具体落到了哪些知识点，可以在“重点”页看荧光笔标记，不对的点一下就能去掉。');
      return;
    }

    // 按主题出题
    if (/(出|来|做|练)\s*(\d+|几|一些|点)?\s*道?.*题/.test(text)) {
      const t = findTopic(course, text);
      const n = +(text.match(/(\d+)\s*道/)?.[1] || 5);
      const count = n <= 5 ? 5 : n <= 10 ? 10 : 20;
      const exam = await tool(t ? `按“${t.title}”出题` : '按计划出题', 500, () => X.createExam(course, count, 'plan', { topicTitle: t?.title, title: t ? `${t.title}专练` : undefined }));
      await act('exam_create', `已开始出题：${exam.title}，${exam.questions.length} 道`, `#/c/${cid}/exam/${exam.id}`, ['practice'], { kind: 'exam', exam_id: exam.id });
      await say(`在出了，出好一道就能先做一道。${t && exam.questions.length < count ? `“${t.title}”的演示题库只有 ${exam.questions.length} 道。` : ''}`);
      return;
    }

    // 讲解
    const ex = EXPLAIN.find((e) => e.keys.some((k) => text.toUpperCase().includes(k.toUpperCase())));
    if (ex) {
      await tool(`查课件：${ex.title}`, 700);
      await say(ex.text);
      const r = refOf(ex.ref);
      if (r) await emit({ type: 'refs', refs: [r] });
      const t = findTopic(course, text);
      if (t) {
        const lv = X.kpLevels(course);
        const marked = t.kp_ids.filter((k) => lv[k] && lv[k] !== 'none').map((k) => course.kps[k].title);
        if (marked.length) await say(`\n\n老师的重点里提到了：${marked.join('、')}。`);
      }
      return;
    }
    const t = findTopic(course, text);
    if (t) {
      await tool(`查课件：${t.title}`, 600);
      await say(`“${t.title}”这部分我在演示数据里没有准备讲解。接上真实后端后，我会检索你的课件来讲，每一句都标出处页码。`);
      return;
    }

    await say('我可以帮你：\n1. 讲解知识点，比如“讲讲银行家算法”\n2. 记下老师说的重点，比如“老师说管程不考”\n3. 调整计划，比如“我只剩 3 天，每天 2 小时”\n4. 按主题出题，比如“出 5 道磁盘调度的题”\n5. 改考试形式，比如“期末是 10 道选择题和 4 道计算题”');
  }
}

/* ---------- 撤销、确认、历史 ---------- */

function markAction(aid) {
  const rec = actions()[aid];
  for (const m of chats()[rec.cid] || []) for (const a of m.actions) if (a.id === aid) a.undone = true;
}

registerRoutes([
  ['GET', /^\/courses\/([^/]+)\/chat$/, ([cid]) => { X.getCourse(cid); return { messages: X.clone(chats()[cid] || []) }; }],
  ['DELETE', /^\/courses\/([^/]+)\/chat$/, ([cid]) => { chats()[cid] = []; return null; }],
  ['POST', /^\/chat-actions\/([^/]+)\/undo$/, ([aid]) => {
    const rec = actions()[aid];
    if (!rec) throw X.notFound('操作');
    if (!rec.undo) throw new X.HttpError(409, 'conflict', '这个操作不能撤销');
    const course = X.getCourse(rec.cid);
    const u = rec.undo;
    let summary = '已撤销';
    if (u.kind === 'replan') { course.plan = u.prev; summary = '已恢复原来的计划'; }
    if (u.kind === 'pin') { if (u.prev) course.plan.pins[u.topic_id] = u.prev; else delete course.plan.pins[u.topic_id]; summary = '已恢复原来的计划'; }
    if (u.kind === 'focus') { Object.assign(course.focus, u.prev, { job_id: null }); summary = '已删掉这条重点'; }
    if (u.kind === 'exam') { delete X.S.exams[u.exam_id]; course.exams = course.exams.filter((e) => e !== u.exam_id); summary = '已删掉这套题'; }
    rec.undo = null;
    markAction(aid);
    return { ok: true, summary };
  }],
  ['POST', /^\/chat-proposals\/([^/]+)$/, ([pid], b) => {
    const rec = proposals()[pid];
    if (!rec) throw X.notFound('提议');
    const course = X.getCourse(rec.cid);
    const accept = !!b?.accept;
    if (accept && rec.apply.kind === 'exam_format') { course.format = { ...course.format, types: rec.apply.types, basis: 'user' }; }
    for (const m of chats()[rec.cid] || []) for (const p of m.proposals) if (p.id === pid) p.status = accept ? 'accepted' : 'declined';
    return { ok: true, summary: accept ? '考试形式已更新' : '没有修改' };
  }],
]);
