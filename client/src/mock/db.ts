// 演示后端的数据表。全部在内存里，浏览器中持久化到 localStorage；结构贴近服务端 v1 的表（08 第 2.3 节）。
import type * as T from '../api/types';

export interface UserRow extends T.User {
  phone: string | null;
  demo: boolean;
  settings: T.Settings;
  reminders: T.Reminders;
  limits: { confirm_tokens: number; daily_tokens: number | null };
  models: T.Models;
  today_minutes: { date: string; minutes: number } | null;
  day_minutes?: Record<string, number>;
  resume: T.Resume | null;
  planned_on: string | null;
  notice: { date: string; text: string; shown: boolean } | null;
}
export interface TokenRow { token: string; user_id: T.ID; kind: 'access' | 'refresh'; device_id: T.ID }
export interface DeviceRow { id: T.ID; user_id: T.ID; kind: T.DeviceKind; name: string; last_seen: string }
export interface QrRow { id: T.ID; status: T.QrStatus['status']; user_id: T.ID | null; device: T.DeviceInfo; created: number }
export interface CourseRow {
  id: T.ID; user_id: T.ID; name: string; color: number; exam_date: string | null; sample: boolean;
  daily_cap_min: number | null; created_at: string; content: 'os' | 'math' | 'ds'; organizing: T.Organizing;
  format: T.ExamFormat; ingested: boolean;
}
export interface ChapterRow { id: T.ID; course_id: T.ID; title: string; order: number }
export interface TopicRow { id: T.ID; course_id: T.ID; chapter_id: T.ID; title: string; order: number; minutes: number; homework: boolean }
export interface KpRow {
  id: T.ID; course_id: T.ID; chapter_id: T.ID; topic_id: T.ID; title: string; order: number; summary: string;
  modes: T.Mode[]; level: T.Level; refs: { material_id: T.ID; page: number }[];
  understood_at: string | null; mark: 'shaky' | 'mastered' | null; stability: number | null; due: string | null;
}
export interface MaterialRow extends T.Material { user_id: T.ID }
export interface PageRow { material_id: T.ID; page: number; title: string; lines: string[]; kp_ids: T.ID[] }
export interface FragmentRow {
  id: T.ID; course_id: T.ID; text: string; found: boolean; created_at: string; analyzed: boolean;
  kps: { id: T.ID; level: 'excluded' | 'mentioned' | 'emphasized'; certainty: 'sure' | 'maybe'; user_choice: boolean | null }[];
}
export interface ConflictRow { id: T.ID; course_id: T.ID; kp_id: T.ID; text: string; choice: 'excluded' | 'emphasized' | null }
export interface BankRow {
  id: T.ID; course_id: T.ID; kp_id: T.ID; type: T.QuestionType; score: number; stem: T.Block[];
  options: { id: string; text: string }[] | null; key: string | null; answer: string;
  steps: T.Block[][]; rubric: { id: T.ID; point: string; score: number }[] | null; hints: [string, string];
  authored: boolean; refs: { material_id: T.ID; page: number }[];
}
export interface SessionRow {
  id: T.ID; user_id: T.ID; kind: T.SessionKind; course_id: T.ID | null; title: string; status: T.SessionStatus;
  created_at: string; started_at: string | null; finished_at: string | null; time_limit_min: number | null;
  position: number; task_id: T.ID | null; job_id: T.ID | null; result: T.Result | null;
}
export interface ItemRow {
  id: T.ID; session_id: T.ID; bank_id: T.ID; index: number; version: number;
  status: T.Question['status']; check: T.Question['check']; check_note: string | null; replaced: boolean;
  hints: T.Hint[]; peeked: boolean; attempt: T.Attempt | null; ready_at: number; check_at: number;
}
export interface EventRow {
  id: T.ID; user_id: T.ID; kp_id: T.ID; bank_id: T.ID; item_id: T.ID; session_id: T.ID;
  outcome: 'correct' | 'wrong' | 'partial'; counted: boolean; hinted: boolean; at: string;
}
export interface MistakeRow {
  user_id: T.ID; bank_id: T.ID; course_id: T.ID; wrong_count: number; correct_streak: number;
  last_wrong_at: string; reason: string; streak_sessions: T.ID[]; removed: boolean;
}
export interface TaskRow extends T.Task { user_id: T.ID }
export interface ThreadRow extends T.Thread { user_id: T.ID }
export interface MessageRow extends T.Message { thread_id: T.ID }
export interface ProviderRow extends T.Connection { user_id: T.ID; key: string }
export interface PluginRow { user_id: T.ID; id: T.ID; installed: boolean; enabled: boolean; scope: 'all' | 'courses'; course_ids: T.ID[]; granted: boolean }
export interface NotificationRow extends T.Notification { user_id: T.ID }
export interface MemoryRow extends T.MemoryItem { user_id: T.ID }
export interface UsageRow {
  id: T.ID; user_id: T.ID; course_id: T.ID | null; feature: T.Feature; plugin_id: T.ID | null; label: string;
  tokens_in: number; tokens_out: number; cost: number | null; created_at: string;
}
export interface JobRow extends T.Job { user_id: T.ID; due: number; payload: Record<string, unknown> }
export interface ReadinessRow { course_id: T.ID; date: string; ratio: number }
export interface FeedbackRow { id: T.ID; user_id: T.ID; kind: string; text: string; created_at: string }
export interface Snapshot { table: TableName; key: string; row: unknown }
export interface UndoRow {
  id: T.ID; user_id: T.ID; label: string; summary: string; created: number; affects: T.Area[];
  snapshots: Snapshot[]; done: boolean; card_id: T.ID | null;
}

export interface Tables {
  users: UserRow; tokens: TokenRow; devices: DeviceRow; qr: QrRow; courses: CourseRow; chapters: ChapterRow;
  topics: TopicRow; kps: KpRow; materials: MaterialRow; pages: PageRow; fragments: FragmentRow;
  conflicts: ConflictRow; bank: BankRow; sessions: SessionRow; items: ItemRow; events: EventRow;
  mistakes: MistakeRow; tasks: TaskRow; threads: ThreadRow; messages: MessageRow; providers: ProviderRow;
  plugins: PluginRow; notifications: NotificationRow; memory: MemoryRow; usage: UsageRow; jobs: JobRow;
  readiness: ReadinessRow; feedback: FeedbackRow; undo: UndoRow;
}
export type TableName = keyof Tables;
export type Db = { v: number; seq: number } & { [K in TableName]: Tables[K][] };

const VERSION = 3;
const STORAGE = 'fullgrid.mock.v1';
const TABLES: TableName[] = [
  'users', 'tokens', 'devices', 'qr', 'courses', 'chapters', 'topics', 'kps', 'materials', 'pages', 'fragments',
  'conflicts', 'bank', 'sessions', 'items', 'events', 'mistakes', 'tasks', 'threads', 'messages', 'providers',
  'plugins', 'notifications', 'memory', 'usage', 'jobs', 'readiness', 'feedback', 'undo',
];

function empty(): Db {
  const base = { v: VERSION, seq: 1 } as Db;
  for (const name of TABLES) (base as Record<string, unknown>)[name] = [];
  return base;
}

const storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage;

function load(): Db {
  if (!storage) return empty();
  try {
    const raw = storage.getItem(STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as Db;
      if (parsed.v === VERSION) return parsed;
    }
  } catch {
    /* 演示数据损坏时重新开始 */
  }
  return empty();
}

export let db: Db = load();

let pending: ReturnType<typeof setTimeout> | null = null;
function write() {
  if (pending) clearTimeout(pending);
  pending = null;
  try {
    storage?.setItem(STORAGE, JSON.stringify(db));
  } catch {
    /* 超出配额时只在内存里继续 */
  }
}
export function persist() {
  if (!storage || pending) return;
  pending = setTimeout(write, 120);
}
/** 页面隐藏或卸载前立即写入，免得刚做的改动（例如刚登录）随整页跳转丢掉 */
export function flush() {
  if (pending) write();
}

export function resetDb() {
  db = empty();
  storage?.removeItem(STORAGE);
}

export function uid(prefix: string) {
  db.seq += 1;
  return `${prefix}_${db.seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// —— 时间：演示后端按浏览器本地时区算“今天” ——
const pad = (n: number) => String(n).padStart(2, '0');
export function isoDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function today() {
  return isoDate(new Date());
}
export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return isoDate(new Date(y, m - 1, d + days));
}
export function daysBetween(from: string, to: string) {
  const [a, b] = [from, to].map((s) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  }) as [number, number];
  return Math.round((b - a) / 86_400_000);
}
export function nowIso(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// —— 通用的表操作 ——
const keyOf = (table: TableName, row: Record<string, unknown>): string => {
  if (table === 'pages') return `${row.material_id}#${row.page}`;
  if (table === 'mistakes') return `${row.user_id}#${row.bank_id}`;
  if (table === 'plugins') return `${row.user_id}#${row.id}`;
  if (table === 'readiness') return `${row.course_id}#${row.date}`;
  if (table === 'tokens') return String(row.token);
  return String(row.id);
};

export function snapshot<K extends TableName>(table: K, row: Tables[K]): Snapshot {
  return { table, key: keyOf(table, row as unknown as Record<string, unknown>), row: structuredClone(row) };
}
/** 新建的行：撤销时删除 */
export function created<K extends TableName>(table: K, row: Tables[K]): Snapshot {
  return { table, key: keyOf(table, row as unknown as Record<string, unknown>), row: null };
}
export function restore(snapshots: Snapshot[]) {
  for (const snap of [...snapshots].reverse()) {
    const list = db[snap.table] as unknown as Record<string, unknown>[];
    const index = list.findIndex((row) => keyOf(snap.table, row) === snap.key);
    if (snap.row === null) {
      if (index >= 0) list.splice(index, 1);
    } else if (index >= 0) list[index] = structuredClone(snap.row) as Record<string, unknown>;
    else list.push(structuredClone(snap.row) as Record<string, unknown>);
  }
}

export function byId<K extends TableName>(table: K, id: T.ID): Tables[K] | undefined {
  return (db[table] as unknown as { id: T.ID }[]).find((row) => row.id === id) as Tables[K] | undefined;
}
export function removeWhere<K extends TableName>(table: K, test: (row: Tables[K]) => boolean) {
  (db as Record<string, unknown>)[table] = (db[table] as Tables[K][]).filter((row) => !test(row));
}
