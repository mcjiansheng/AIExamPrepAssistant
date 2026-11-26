// 每个接口一个函数，路径和类型照抄 api-v1.md。
import { http, streamEvents } from './client';
import type * as T from './types';

const q = (params: Record<string, string | number | null | undefined>) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') search.set(k, String(v));
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => http.get<T.Health>('/health'),
  undo: (id: T.ID) => http.post<{ ok: true; affects: T.Area[]; summary: string }>(`/undo/${id}`),
  job: (id: T.ID) => http.get<T.Job>(`/jobs/${id}`),
  retryJob: (id: T.ID) => http.post<T.Job>(`/jobs/${id}/retry`),
  /** needs_input 的任务：确认用量或提高上限后继续 */
  continueJob: (id: T.ID) => http.post<T.Job>(`/jobs/${id}/continue`),

  // 认证与账号
  sms: (phone: string) => http.post<{ cooldown_sec: number; dev_code: string | null }>('/auth/sms', { phone }),
  login: (phone: string, code: string, device: T.DeviceInfo) => http.post<T.Tokens>('/auth/login', { phone, code, device }),
  guest: (device: T.DeviceInfo) => http.post<T.Tokens>('/auth/guest', { device }),
  qr: (device: T.DeviceInfo) => http.post<T.QrTicket>('/auth/qr', { device }),
  qrStatus: (id: T.ID) => http.get<T.QrStatus>(`/auth/qr/${id}`),
  // raw：刷新失败直接抛出，不再触发 401 拦截（否则会递归）
  refresh: (refresh_token: string) => http.post<T.Tokens>('/auth/refresh', { refresh_token }, { raw: true }),
  logout: () => http.post<void>('/auth/logout'),
  me: () => http.get<T.User>('/me'),
  updateMe: (body: Partial<Pick<T.User, 'nickname' | 'school' | 'major' | 'timezone' | 'onboarding'>>) => http.patch<T.User>('/me', body),
  stats: () => http.get<T.Stats>('/me/stats'),
  devices: () => http.get<T.Device[]>('/me/devices'),
  removeDevice: (id: T.ID) => http.del<void>(`/me/devices/${id}`),
  exportData: () => http.post<T.Job>('/me/export'),
  deleteAccount: () => http.del<{ deletion_at: string }>('/me'),
  restoreAccount: () => http.post<T.User>('/me/restore'),
  resume: (body: T.ResumeInput) => http.put<void>('/me/resume', body as unknown as Record<string, unknown>),
  feedback: (kind: 'bug' | 'idea' | 'report', text: string, context: string | null) => http.post<void>('/feedback', { kind, text, context }),

  // 设置
  settings: () => http.get<T.Settings>('/me/settings'),
  updateSettings: (body: Partial<T.Settings>) => http.patch<T.Change<T.Settings>>('/me/settings', body),
  reminders: () => http.get<T.Reminders>('/me/reminders'),
  setReminders: (body: T.Reminders) => http.put<T.Reminders>('/me/reminders', body as unknown as Record<string, unknown>),
  memory: () => http.get<T.MemoryItem[]>('/me/memory'),
  forget: (id: T.ID) => http.del<void>(`/me/memory/${id}`),
  forgetAll: () => http.del<void>('/me/memory'),

  // 模型
  presets: () => http.get<T.Preset[]>('/providers/presets'),
  providers: () => http.get<T.Connection[]>('/me/providers'),
  addProvider: (body: { preset_id: T.ID; key: string } | { name: string; protocol: 'openai'; base_url: string; key: string; model?: string }) =>
    http.post<T.Connection>('/me/providers', body),
  updateProvider: (id: T.ID, body: { key?: string; name?: string; base_url?: string }) => http.patch<T.Connection>(`/me/providers/${id}`, body),
  removeProvider: (id: T.ID) => http.del<void>(`/me/providers/${id}`),
  checkProvider: (id: T.ID) => http.post<T.CheckResult>(`/me/providers/${id}/check`),
  models: () => http.get<T.Models>('/me/models'),
  setModels: (roles: Partial<T.Models['roles']>) => http.put<T.Models>('/me/models', { roles }),
  usage: (period: 'week' | 'month') => http.get<T.Usage>(`/me/usage${q({ period })}`),
  limits: () => http.get<T.Limits>('/me/limits'),
  setLimits: (body: { confirm_tokens?: number; daily_tokens?: number | null }) => http.put<T.Limits>('/me/limits', body),
  estimate: (body: Record<string, unknown>) => http.post<T.Estimate>('/estimate', body),

  // 今天与日程
  today: () => http.get<T.Today>('/today'),
  setTodayMinutes: (minutes: number) => http.patch<T.Change<T.Today>>('/today', { minutes }),
  updateTask: (id: T.ID, body: { status?: T.Task['status']; date?: string; pinned?: boolean }) => http.patch<T.Change<T.Task>>(`/tasks/${id}`, body),
  schedule: (from?: string, to?: string) => http.get<T.Schedule>(`/schedule${q({ from, to })}`),
  setDayMinutes: (date: string, minutes: number) => http.patch<T.Change<T.ScheduleDay>>(`/schedule/days/${date}`, { minutes }),
  rebuildSchedule: () => http.post<T.Change<T.Schedule>>('/schedule/rebuild'),

  // 课程与知识点
  courses: () => http.get<T.Course[]>('/courses'),
  createCourse: (body: { name: string; exam_date?: string | null; color?: number }) => http.post<T.Course>('/courses', body),
  course: (cid: T.ID) => http.get<T.Course>(`/courses/${cid}`),
  updateCourse: (cid: T.ID, body: Partial<Pick<T.Course, 'name' | 'exam_date' | 'color' | 'daily_cap_min'>>) =>
    http.patch<T.Change<T.Course>>(`/courses/${cid}`, body),
  deleteCourse: (cid: T.ID) => http.del<void>(`/courses/${cid}`),
  courseHome: (cid: T.ID) => http.get<T.CourseHome>(`/courses/${cid}/home`),
  courseMap: (cid: T.ID) => http.get<T.CourseMap>(`/courses/${cid}/map`),
  kp: (kid: T.ID, taskId?: T.ID | null) => http.get<T.KpDetail>(`/kps/${kid}${q({ task_id: taskId })}`),
  understood: (kid: T.ID, taskId?: T.ID | null) =>
    http.post<T.Change<{ kp: T.KpBrief; next_kp_id: T.ID | null; task: T.Task | null }>>(`/kps/${kid}/understood`, { task_id: taskId ?? null }),
  markKp: (kid: T.ID, mark: 'shaky' | 'mastered' | null) => http.post<T.Change<T.KpBrief>>(`/kps/${kid}/mark`, { mark }),

  // 资料
  materials: (cid: T.ID) => http.get<T.Material[]>(`/courses/${cid}/materials`),
  upload: (cid: T.ID, files: File[], source: 'file' | 'photo' = 'file') => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    form.append('source', source);
    return http.post<{ materials: T.Material[]; job: T.Job | null }>(`/courses/${cid}/materials`, form);
  },
  setMaterialKind: (mid: T.ID, kind: T.MaterialKind) => http.patch<T.Change<T.Material>>(`/materials/${mid}`, { kind }),
  decide: (mid: T.ID, choice: string) => http.post<T.Change<T.Material>>(`/materials/${mid}/decision`, { choice }),
  deleteMaterial: (mid: T.ID) => http.del<void>(`/materials/${mid}`),
  pages: (mid: T.ID) => http.get<{ pages: T.PageThumb[] }>(`/materials/${mid}/pages`),
  page: (mid: T.ID, n: number) => http.get<T.Page>(`/materials/${mid}/pages/${n}`),
  photoLink: (cid: T.ID) => http.post<{ url: string; expires_at: string }>(`/courses/${cid}/photo-link`),

  // 老师重点与考试形式
  focus: (cid: T.ID) => http.get<T.Focus>(`/courses/${cid}/focus`),
  addFragments: (cid: T.ID, text: string, source: 'text' | 'photo' = 'text') => http.post<T.Focus>(`/courses/${cid}/focus/fragments`, { text, source }),
  deleteFragment: (fid: T.ID) => http.del<T.Change<T.Focus>>(`/focus/fragments/${fid}`),
  includeKp: (cid: T.ID, kp_id: T.ID, include: boolean | null) => http.post<T.Change<T.Focus>>(`/courses/${cid}/focus/kps`, { kp_id, include }),
  resolveConflict: (id: T.ID, choice: 'excluded' | 'emphasized') => http.post<T.Change<T.Focus>>(`/focus/conflicts/${id}`, { choice }),
  examFormat: (cid: T.ID) => http.get<T.ExamFormat>(`/courses/${cid}/exam-format`),
  setExamFormat: (cid: T.ID, body: Omit<T.ExamFormat, 'basis'>) => http.put<T.Change<T.ExamFormat>>(`/courses/${cid}/exam-format`, body),

  // 练习
  practice: (courseId?: T.ID | null) => http.get<T.PracticeHub>(`/practice${q({ course_id: courseId })}`),
  createSession: (body: T.NewSession) => http.post<T.Session>('/sessions', body as unknown as Record<string, unknown>),
  session: (sid: T.ID) => http.get<T.Session>(`/sessions/${sid}`),
  setPosition: (sid: T.ID, position: number) => http.patch<void>(`/sessions/${sid}`, { position }),
  finish: (sid: T.ID) => http.post<T.Result>(`/sessions/${sid}/finish`),
  result: (sid: T.ID) => http.get<T.Result>(`/sessions/${sid}/result`),
  deleteSession: (sid: T.ID) => http.del<void>(`/sessions/${sid}`),
  attempt: (qid: T.ID, response: string | null) => http.post<T.AttemptResult>(`/questions/${qid}/attempt`, { response }),
  grade: (qid: T.ID, marks: Record<string, T.Mark>) => http.post<T.AttemptResult>(`/questions/${qid}/grade`, { marks }),
  hint: (qid: T.ID, level: 1 | 2 | 3) => http.post<{ hint: T.Hint; question: T.Question }>(`/questions/${qid}/hint`, { level }),
  report: (qid: T.ID, kind: T.ReportKind, note: string | null) => http.post<{ question: T.Question }>(`/questions/${qid}/report`, { kind, note }),
  mistakes: (courseId?: T.ID | null) => http.get<T.Mistake[]>(`/mistakes${q({ course_id: courseId })}`),
  removeMistake: (bankId: T.ID) => http.del<T.Change<null>>(`/mistakes/${bankId}`),
  similar: (bankId: T.ID) => http.post<T.Session>(`/mistakes/${bankId}/similar`),

  // 学情
  insight: (cid: T.ID) => http.get<T.Insight>(`/courses/${cid}/insight`),

  // 助手
  threads: () => http.get<T.Thread[]>('/threads'),
  createThread: (body: { course_id?: T.ID | null; title?: string }) => http.post<T.Thread>('/threads', body),
  updateThread: (tid: T.ID, body: { title?: string; model?: string | null }) => http.patch<T.Thread>(`/threads/${tid}`, body),
  deleteThread: (tid: T.ID) => http.del<void>(`/threads/${tid}`),
  thread: (tid: T.ID) => http.get<{ thread: T.Thread; messages: T.Message[] }>(`/threads/${tid}?limit=50`),
  send: (tid: T.ID, body: { text: string; context: T.ChatContext; command?: T.Command; attachments?: T.ID[] }, signal?: AbortSignal) =>
    streamEvents(`/threads/${tid}/messages`, body as unknown as Record<string, unknown>, signal),
  stop: (tid: T.ID) => http.post<void>(`/threads/${tid}/stop`),
  resolveProposal: (cardId: T.ID, accept: boolean) => http.post<{ card: T.Card; affects: T.Area[] }>(`/proposals/${cardId}`, { accept }),
  stopTask: (jobId: T.ID) => http.post<void>(`/agent-tasks/${jobId}/stop`),

  // 通知
  notifications: () => http.get<{ items: T.Notification[]; unread: number }>('/notifications?limit=50'),
  readNotifications: (ids?: T.ID[]) => http.post<{ unread: number }>('/notifications/read', ids ? { ids } : {}),

  // 插件
  plugins: () => http.get<T.Plugin[]>('/plugins'),
  plugin: (id: T.ID) => http.get<T.PluginDetail>(`/plugins/${id}`),
  addPlugin: (url: string) => http.post<T.Plugin>('/plugins', { url }),
  installPlugin: (id: T.ID) => http.post<T.Plugin>(`/plugins/${id}/install`),
  updatePlugin: (id: T.ID, body: { enabled?: boolean; scope?: 'all' | 'courses'; course_ids?: T.ID[] }) => http.patch<T.Plugin>(`/plugins/${id}`, body),
  removePlugin: (id: T.ID) => http.del<void>(`/plugins/${id}`),
};
