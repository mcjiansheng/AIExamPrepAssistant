// 与 docs/接口合同/api-v1.md 一一对应。改这里之前先改合同（AGENTS.md「接口变更」）。

export type ID = string;

export type Area =
  | 'today' | 'schedule' | 'courses' | 'course' | 'map' | 'kp' | 'materials' | 'focus'
  | 'practice' | 'session' | 'mistakes' | 'insight' | 'threads' | 'settings' | 'providers'
  | 'plugins' | 'notifications';

export interface Undo { id: ID; label: string; expires_at: string }
export interface Change<T> { result: T; affects: Area[]; undo: Undo | null }

export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'login_required' | 'forbidden' | 'not_found' | 'conflict'
  | 'ai_required' | 'needs_confirmation' | 'too_large' | 'unsupported_type' | 'rate_limited'
  | 'internal' | 'network';
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; hint: string | null; detail: Record<string, unknown> | null };
}

export interface Job {
  id: ID;
  kind: 'ingest' | 'focus' | 'session' | 'agent' | 'export';
  status: 'queued' | 'running' | 'done' | 'failed' | 'needs_input';
  progress: number | null;
  stage: string | null;
  error: { message: string; retryable: boolean } | null;
  course_id: ID | null;
  target_id: ID;
  result: { url: string | null } | null;
  /** needs_input 且在等用户确认用量时非空（合同 v1.1 第 3 节） */
  estimate: Estimate | null;
  created_at: string;
}

export interface Health { ok: true; version: string; capabilities: { ocr: boolean; speech: boolean }; sms: 'dev' | 'live' }

// 5 认证与账号
export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'browser';
export interface DeviceInfo { kind: DeviceKind; name: string; timezone: string }
export interface User {
  id: ID;
  nickname: string;
  avatar_url: string | null;
  phone_masked: string | null;
  guest: boolean;
  school: string | null;
  major: string | null;
  timezone: string;
  onboarding: { ai: 'done' | 'skipped' | null; course: 'done' | 'skipped' | null };
  deletion_at: string | null;
  created_at: string;
}
export interface Tokens { access_token: string; refresh_token: string; expires_in: number; user: User; is_new: boolean }
export interface QrTicket { id: ID; payload: string; expires_at: string }
export interface QrStatus { status: 'waiting' | 'scanned' | 'confirmed' | 'expired'; tokens: Tokens | null }
export interface Device { id: ID; kind: DeviceKind; name: string; last_seen: string; current: boolean }
export interface ResumeInput { kind: 'kp' | 'session'; course_id: ID; kp_id?: ID; session_id?: ID; position?: number }
export interface Stats { week_minutes: number; streak_days: number }

// 6 设置
export type Intensity = 'easy' | 'standard' | 'sprint';
export interface Settings {
  daily_minutes: number;
  intensity: Intensity;
  theme: 'system' | 'light' | 'dark';
  reduce_motion: 'system' | 'on' | 'off';
  briefing: boolean;
  proactive_hints: boolean;
  memory: boolean;
}
export interface Reminders { daily: { enabled: boolean; time: string }; exam_soon: boolean; jobs: boolean }
export interface MemoryItem { id: ID; text: string; source: 'user' | 'practice'; created_at: string }

// 7 模型
export type Protocol = 'openai' | 'longcat' | 'anthropic';
export interface PresetModel { id: string; name: string; vision: boolean; context_k: number; price: { input: number; output: number } | null }
export interface Preset {
  id: ID; name: string; tagline: string; price_tier: 1 | 2 | 3; protocol: Protocol; base_url: string;
  key_url: string; key_steps: string[]; models: PresetModel[]; default_model: string;
}
export interface Capabilities { chat: boolean; json: boolean; tools: boolean; vision: boolean; stream: boolean; context_k: number | null }
export interface Connection {
  id: ID; preset_id: ID | null; name: string; protocol: Protocol; base_url: string; key_last4: string;
  status: 'unchecked' | 'ok' | 'invalid' | 'limited'; status_message: string | null; checked_at: string | null;
  capabilities: Capabilities | null; models: string[];
}
export type CheckStepId = 'connect' | 'models' | 'json' | 'tools' | 'vision';
export interface CheckStep { id: CheckStepId; ok: boolean; message: string | null }
export interface CheckResult { connection: Connection; steps: CheckStep[] }
export type Role = 'chat' | 'organize' | 'generate' | 'vision';
export interface RoleBinding { connection_id: ID; model: string }
export interface Models {
  roles: Record<Role, RoleBinding | null>;
  ocr: 'builtin' | RoleBinding;
  speech: 'disabled' | 'builtin' | RoleBinding;
}
export interface Estimate { tokens_min: number; tokens_max: number; cost_min: number | null; cost_max: number | null; needs_confirm: boolean }
export interface Tally { tokens_in: number; tokens_out: number; cost: number | null }
export type Feature = 'chat' | 'organize' | 'generate' | 'verify' | 'vision' | 'plugin';
export interface Usage {
  period: 'week' | 'month'; from: string; to: string; total: Tally;
  by_feature: (Tally & { feature: Feature })[];
  by_course: (Tally & { course_id: ID; name: string })[];
  by_plugin: (Tally & { plugin_id: ID; name: string })[];
  daily: { date: string; tokens: number }[];
  recent: { id: ID; label: string; course_name: string | null; tokens: number; cost: number | null; created_at: string }[];
}
export interface Limits { confirm_tokens: number; daily_tokens: number | null; today_tokens: number }

// 8 今天与日程
export type TaskKind = 'learn' | 'practice' | 'review' | 'mock' | 'mistakes';
export interface Task {
  id: ID; course_id: ID; date: string; kind: TaskKind; title: string; minutes: number;
  status: 'todo' | 'done' | 'skipped'; reason: string; moved_from: string | null; pinned: boolean;
  kp_ids: ID[]; session_id: ID | null; progress: { done: number; total: number } | null;
}
export interface Countdown { course_id: ID; name: string; color: number; exam_date: string; days_left: number; urgent: boolean }
export interface Resume { kind: 'kp' | 'session'; course_id: ID; title: string; detail: string | null; href: string; updated_at: string; device: string | null }
export interface Today {
  date: string; briefing: string | null; minutes_available: number; minutes_planned: number;
  progress: { done: number; total: number }; countdowns: Countdown[]; resume: Resume | null;
  tasks: Task[]; done: Task[]; notice: string | null; tomorrow: Task[];
}
export interface ScheduleDay {
  date: string; minutes_available: number; minutes_planned: number; tasks: Task[];
  exams: { course_id: ID; name: string; color: number }[];
}
export interface Schedule { from: string; to: string; daily_minutes: number; intensity: Intensity; days: ScheduleDay[] }

// 9 课程与知识点
export type KpState = 'new' | 'learned' | 'shaky' | 'mastered';
export type Level = 'emphasized' | 'conflict' | 'mentioned' | 'none' | 'excluded';
export type Mode = 'memory' | 'understand' | 'compute' | 'design' | 'proof' | 'linked' | 'major';
export interface Organizing {
  state: 'idle' | 'working' | 'waiting_ai' | 'waiting_confirm' | 'attention'; progress: number | null; stage: string | null;
  job_id: ID | null; attention: string | null;
}
export interface Course {
  id: ID; name: string; color: number; exam_date: string | null; days_left: number | null; sample: boolean;
  readiness: { mastered: number; total: number }; organizing: Organizing;
  counts: { kps: number; materials: number; fragments: number; mistakes: number };
  daily_cap_min: number | null; created_at: string;
}
export interface MapCell { id: ID; title: string; state: KpState; level: Level; topic_id: ID }
export interface MapChapter { id: ID; title: string; mastered: number; total: number; kps: MapCell[] }
export interface CourseMap { course_id: ID; chapters: MapChapter[] }
export interface KpBrief { id: ID; course_id: ID; title: string; state: KpState; level: Level; chapter_title: string }
export interface CourseHome { course: Course; map: CourseMap; next: Task[]; weak: KpBrief[]; last_session: SessionSummary | null }
export interface Ref { material_id: ID; material_title: string; page: number; quote: string | null }
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; text: string; lang: string | null }
  | { kind: 'formula'; text: string }
  | { kind: 'image'; url: string; alt: string };
export interface KpDetail {
  id: ID; course_id: ID; title: string; chapter: { id: ID; title: string }; topic: { id: ID; title: string };
  state: KpState; level: Level; modes: Mode[]; types: QuestionType[];
  teacher: { text: string; fragment_id: ID }[]; sections: { blocks: Block[]; refs: Ref[] }[]; pages: Ref[];
  quiz: Question[]; map: MapChapter; prev_id: ID | null; next_id: ID | null;
  task: { id: ID; index: number; total: number } | null; understood_at: string | null;
}

// 10 资料
export type MaterialKind = 'slides' | 'homework' | 'notes' | 'review' | 'past_paper' | 'photo' | 'other';
export interface Material {
  id: ID; course_id: ID; title: string; kind: MaterialKind; source: 'file' | 'photo'; pages: number | null;
  status: 'waiting_ai' | 'waiting_confirm' | 'reading' | 'extracting' | 'ready' | 'failed'; stage: string | null; progress: number | null;
  kp_count: number | null; question_count: number; vision: 'none' | 'partial' | 'done' | 'unsupported';
  superseded_by: ID | null;
  decision: { kind: 'version' | 'role'; text: string; options: { id: string; label: string }[]; choice: string } | null;
  skipped_pages: number[]; error: { message: string; retryable: boolean } | null; uploaded_at: string;
}
export interface Page { material_id: ID; material_title: string; page: number; total: number; text: string; image_url: string | null; kps: KpBrief[] }
export interface PageThumb { page: number; title: string | null; thumb_url: string | null }

// 11 老师重点与考试形式
export interface FragmentKp {
  id: ID; title: string; level: 'excluded' | 'mentioned' | 'emphasized'; certainty: 'sure' | 'maybe';
  user_choice: boolean | null; included: boolean;
}
export interface Fragment { id: ID; text: string; found: boolean; created_at: string; kps: FragmentKp[] }
export interface Conflict { id: ID; kp_id: ID; title: string; text: string; choice: 'excluded' | 'emphasized' | null }
export interface Focus { course_id: ID; fragments: Fragment[]; conflicts: Conflict[]; job: Job | null }
export type QuestionType = 'single' | 'fill' | 'calc' | 'short' | 'proof' | 'design';
export interface ExamFormat {
  types: { type: QuestionType; count: number; score: number }[];
  duration_min: number | null; open_book: boolean | null;
  basis: 'teacher' | 'past_paper' | 'review' | 'default' | 'user';
}

// 12 练习与作答
export type SessionKind = 'quick' | 'kp' | 'review' | 'mistakes' | 'mock';
export type SessionStatus = 'preparing' | 'active' | 'finished' | 'failed';
export interface SessionSummary {
  id: ID; kind: SessionKind; course_id: ID | null; course_name: string | null; title: string; status: SessionStatus;
  created_at: string; finished_at: string | null; question_count: number; answered: number; score: number | null; total: number;
}
export interface Hint { level: 1 | 2 | 3; text: string; refs: Ref[] }
export interface Solution { answer: string; steps: { n: number; blocks: Block[]; refs: Ref[] }[]; rubric: { id: ID; point: string; score: number }[] | null }
export type Mark = 'full' | 'partial' | 'none';
export interface Attempt {
  response: string | null; state: 'graded' | 'needs_self_grade'; correct: boolean | null; score: number | null;
  marks: Record<string, Mark> | null; answered_at: string;
}
export interface Question {
  id: ID; bank_id: ID; index: number; version: number; type: QuestionType;
  status: 'pending' | 'ready' | 'failed' | 'hidden'; check: 'checking' | 'passed' | 'flagged' | 'unchecked';
  check_note: string | null; replaced: boolean; score: number; kp: { id: ID; title: string }; course_id: ID;
  stem: Block[]; options: { id: string; text: string }[] | null; refs: Ref[]; hints: Hint[]; peeked: boolean;
  attempt: Attempt | null; solution: Solution | null;
}
export interface Session {
  id: ID; kind: SessionKind; course_id: ID | null; title: string; status: SessionStatus;
  created_at: string; started_at: string | null; finished_at: string | null; time_limit_min: number | null;
  position: number; task_id: ID | null; job: Job | null; questions: Question[]; score: number | null; total: number;
}
export interface MasteryChange { kp_id: ID; title: string; from: KpState; to: KpState }
export interface AttemptResult { question: Question; mastery: MasteryChange[]; mistake_added: boolean }
export interface ReviewAction {
  label: string; kind: 'kp' | 'session'; kp_id: ID | null;
  session: { kind: SessionKind; course_id: ID; kp_id: ID | null; count: number } | null;
}
export interface Result {
  session: Session; score: number; total: number; accuracy: number; duration_sec: number;
  mastery: MasteryChange[]; chapters: MapChapter[]; mistakes: Question[];
  review: { text: string; actions: ReviewAction[] } | null; task: Task | null;
}
export interface PracticeHub {
  course_id: ID | null; quick: { count: number; minutes: number }; review: { count: number; minutes: number };
  mistakes: { count: number }; mock: { available: boolean; count: number; minutes: number; basis: ExamFormat['basis'] };
  history: SessionSummary[];
}
export interface Mistake {
  question: Question; course_id: ID; course_name: string; reason: string; wrong_count: number;
  correct_streak: number; last_wrong_at: string;
}
export type ReportKind = 'wrong_answer' | 'wrong_solution' | 'out_of_scope' | 'unclear' | 'wrong_ref';
export interface NewSession {
  kind: SessionKind; course_id?: ID | null; kp_id?: ID; question_ids?: ID[]; count?: number; task_id?: ID; confirm?: boolean;
}

// 13 学情
export interface Insight {
  course_id: ID; verdict: string; readiness: { date: string; ratio: number }[];
  chapters: { id: ID; title: string; new: number; learned: number; shaky: number; mastered: number }[];
  weak: KpBrief[]; minutes: { total: number; learn: number; practice: number; review: number; mock: number };
}

// 14 助手
export interface Thread {
  id: ID; course_id: ID | null; title: string; kind: 'course' | 'global' | 'custom'; model: string | null;
  updated_at: string; preview: string | null;
}
export interface ChatContext {
  route: string; course_id?: ID; kp_id?: ID; session_id?: ID; question_id?: ID; material_id?: ID; page?: number; selection?: string;
}
export type Command = 'simplify' | 'example' | 'quiz' | 'compare' | 'outline' | 'today' | 'review' | `plugin:${string}`;
export interface Message {
  id: ID; role: 'user' | 'assistant'; text: string; created_at: string; tools: { label: string }[]; refs: Ref[];
  cards: Card[]; memory: MemoryItem[]; status: 'done' | 'error' | 'stopped'; error: { code: string; message: string } | null;
}
export type ChatEvent =
  | { type: 'start'; message_id: ID; user_message_id: ID }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: ID; label: string; status: 'running' | 'done' | 'failed' }
  | { type: 'refs'; refs: Ref[] }
  | { type: 'card'; card: Card }
  | { type: 'memory'; item: MemoryItem }
  | { type: 'done' }
  | { type: 'error'; code: 'ai_required' | 'provider_error' | 'tool_failed' | 'internal'; message: string; retryable: boolean };
export interface ChangeRow { label: string; from: string; to: string }
export interface TemplateNode {
  type: 'text' | 'title' | 'image' | 'table' | 'code' | 'formula' | 'list' | 'progress' | 'button' | 'columns';
  props: Record<string, unknown>; children?: TemplateNode[];
}
interface CardBase { id: ID; created_at: string }
export type Card = CardBase & (
  | { kind: 'change'; title: string; changes: ChangeRow[]; affects: Area[]; undo_id: ID | null; state: 'applied' | 'undone' | 'expired'; href: string | null }
  | { kind: 'proposal'; title: string; changes: ChangeRow[]; estimate: Estimate | null; affects: Area[]; state: 'pending' | 'accepted' | 'declined' }
  | { kind: 'question'; question: Question }
  | { kind: 'practice'; title: string; session_kind: SessionKind; course_id: ID; kp_id: ID | null; count: number; minutes: number; session_id: ID | null }
  | { kind: 'explain'; title: string; kp_id: ID | null; blocks: Block[]; refs: Ref[] }
  | { kind: 'map'; course_id: ID; chapter: MapChapter }
  | { kind: 'schedule'; title: string; days: { date: string; tasks: Task[] }[] }
  | { kind: 'task'; title: string; steps: { label: string; status: 'pending' | 'running' | 'done' | 'failed' | 'stopped' }[]; job_id: ID | null; state: 'running' | 'done' | 'stopped' | 'failed'; href: string | null }
  | { kind: 'material'; material: Material }
  | { kind: 'usage'; label: string; tokens: number; cost: number | null }
  | { kind: 'connect'; reason: string }
  | { kind: 'plugin'; plugin_id: ID; template: TemplateNode }
);
export type CardKind = Card['kind'];

// 15 事件流
export type ServerEvent =
  | { type: 'changed'; areas: Area[]; course_id: ID | null }
  | { type: 'job'; job: Job }
  | { type: 'question'; session_id: ID; question: Question }
  | { type: 'notification'; notification: Notification }
  | { type: 'resume'; resume: Resume };

// 16 通知
export interface Notification {
  id: ID; kind: 'job_done' | 'job_failed' | 'exam_soon' | 'daily' | 'device'; title: string; body: string | null;
  href: string | null; created_at: string; read: boolean;
}

// 17 插件
export interface Plugin {
  id: ID; name: string; version: string; description: string; source: 'builtin' | 'file' | 'url';
  installed: boolean; enabled: boolean; scope: 'all' | 'courses'; course_ids: ID[];
  permissions: { read: string[]; write: string[]; network: string[]; model: boolean }; granted: boolean;
  commands: { name: string; description: string }[]; question_types: { id: string; name: string }[];
  cost: string; usage_tokens: number;
}
export interface PluginDetail extends Plugin { readme: string }
