// 后端 API 客户端。路径和字段见 docs/接口合同/api-v0.md。
// 启动时探测 /api/health：有后端就连后端，没有就用 js/mock/ 里的演示后端。
// 也可以用 ?api=mock 或 ?api=real 强制指定。

export class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

let mode = 'real';
let mockRequest = null;
let mockChat = null;

export async function initApi() {
  const forced = new URLSearchParams(location.search).get('api');
  if (forced === 'mock' || (forced !== 'real' && !(await backendAlive()))) {
    mode = 'mock';
    ({ mockRequest } = await import('./mock/server.js'));
    ({ mockChat } = await import('./mock/chat.js'));
  }
  return mode;
}
export const apiMode = () => mode;

async function backendAlive() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return false;
    const data = await r.json();
    return data?.ok === true;
  } catch { return false; }
}

async function request(method, path, body) {
  if (mode === 'mock') return mockRequest(method, path, body);
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + path, opts); }
  catch { throw new ApiError('连不上后端服务，确认它还在运行后再试', 'network', 0); }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(data?.error?.message || `请求没有完成（${r.status}）`, data?.error?.code, r.status);
  return data;
}

const get = (p) => request('GET', p);
const post = (p, b = {}) => request('POST', p, b);
const put = (p, b) => request('PUT', p, b);
const patch = (p, b) => request('PATCH', p, b);
const del = (p) => request('DELETE', p);
const e = encodeURIComponent;

export const api = {
  health: () => get('/health'),
  job: (id) => get(`/jobs/${e(id)}`),
  retryJob: (id) => post(`/jobs/${e(id)}/retry`),

  courses: () => get('/courses'),
  course: (cid) => get(`/courses/${e(cid)}`),
  createCourse: (b) => post('/courses', b),
  updateCourse: (cid, b) => patch(`/courses/${e(cid)}`, b),
  deleteCourse: (cid) => del(`/courses/${e(cid)}`),

  materials: (cid) => get(`/courses/${e(cid)}/materials`),
  upload: (cid, files) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return request('POST', `/courses/${e(cid)}/materials`, fd);
  },
  updateMaterial: (mid, b) => patch(`/materials/${e(mid)}`, b),
  deleteMaterial: (mid) => del(`/materials/${e(mid)}`),
  page: (mid, n) => get(`/materials/${e(mid)}/pages/${n}`),
  answerSuggestion: (sid, choice) => post(`/suggestions/${e(sid)}`, { choice }),

  topics: (cid) => get(`/courses/${e(cid)}/topics`),

  focus: (cid) => get(`/courses/${e(cid)}/focus`),
  analyzeFocus: (cid, text) => put(`/courses/${e(cid)}/focus`, { text }),
  setFocusKp: (cid, kp_id, include) => post(`/courses/${e(cid)}/focus/kps`, { kp_id, include }),
  examFormat: (cid) => get(`/courses/${e(cid)}/exam-format`),
  saveExamFormat: (cid, f) => put(`/courses/${e(cid)}/exam-format`, f),

  plan: (cid) => get(`/courses/${e(cid)}/plan`),
  makePlan: (cid, b) => post(`/courses/${e(cid)}/plan`, b),
  pin: (cid, topic_id, pin) => post(`/courses/${e(cid)}/plan/pins`, { topic_id, pin }),
  setItemDone: (id, done) => post(`/plan-items/${e(id)}`, { done }),

  exams: (cid) => get(`/courses/${e(cid)}/exams`),
  createExam: (cid, b) => post(`/courses/${e(cid)}/exams`, b),
  exam: (eid) => get(`/exams/${e(eid)}`),
  finishExam: (eid) => post(`/exams/${e(eid)}/finish`),
  examResult: (eid) => get(`/exams/${e(eid)}/result`),
  attempt: (qid, response) => post(`/questions/${e(qid)}/attempt`, { response }),
  grade: (qid, marks) => post(`/questions/${e(qid)}/grade`, { marks }),
  report: (qid, kind, note) => post(`/questions/${e(qid)}/report`, { kind, note }),

  chatHistory: (cid) => get(`/courses/${e(cid)}/chat`),
  clearChat: (cid) => del(`/courses/${e(cid)}/chat`),
  undoAction: (aid) => post(`/chat-actions/${e(aid)}/undo`),
  answerProposal: (pid, accept) => post(`/chat-proposals/${e(pid)}`, { accept }),
  /** 发送一条消息，onEvent 逐个收到 ChatEvent（合同第 10 节） */
  chat: (cid, text, context, onEvent) => streamChat(cid, { text, context }, onEvent),
};

async function streamChat(cid, body, onEvent) {
  if (mode === 'mock') return mockChat(cid, body, onEvent);
  let r;
  try {
    r = await fetch(`/api/courses/${e(cid)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new ApiError('连不上后端服务，确认它还在运行后再试', 'network', 0); }
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    throw new ApiError(data?.error?.message || `请求没有完成（${r.status}）`, data?.error?.code, r.status);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}
