// 撤销：改动前给受影响的行拍快照，撤销时还原（09 第 9 节：后续改动碰到同一对象前有效，最长 24 小时）。
import type * as T from '../api/types';
import { created, db, restore, snapshot, uid, type Snapshot, type TableName, type Tables, type UndoRow, type UserRow } from './db';
import { ApiErr } from './errors';

export interface Tracker {
  before<K extends TableName>(table: K, row: Tables[K]): void;
  added<K extends TableName>(table: K, row: Tables[K]): void;
}

export function withUndo(user: UserRow, label: string, summary: string, affects: T.Area[], mutate: (t: Tracker) => void): T.Undo {
  const snapshots: Snapshot[] = [];
  const seen = new Set<string>();
  const tracker: Tracker = {
    before(table, row) {
      const snap = snapshot(table, row);
      const key = `${table}:${snap.key}`;
      if (seen.has(key)) return;
      seen.add(key);
      snapshots.push(snap);
    },
    added(table, row) {
      const snap = created(table, row);
      seen.add(`${table}:${snap.key}`);
      snapshots.push(snap);
    },
  };
  mutate(tracker);
  const keys = new Set(snapshots.map((s) => `${s.table}:${s.key}`));
  for (const older of db.undo) {
    if (older.user_id === user.id && !older.done && older.snapshots.some((s) => keys.has(`${s.table}:${s.key}`))) older.done = true;
  }
  const row: UndoRow = { id: uid('ud'), user_id: user.id, label, summary, created: Date.now(), affects, snapshots, done: false, card_id: null };
  db.undo.push(row);
  return { id: row.id, label, expires_at: new Date(row.created + 86_400_000).toISOString() };
}

export function applyUndo(user: UserRow, id: T.ID) {
  const row = db.undo.find((u) => u.id === id && u.user_id === user.id);
  if (!row) throw new ApiErr(404, 'not_found', '这次改动不存在');
  if (row.done || Date.now() - row.created > 86_400_000) throw new ApiErr(409, 'conflict', '这次改动已经无法撤销');
  restore(row.snapshots);
  row.done = true;
  for (const m of db.messages) {
    for (const card of m.cards) if (card.kind === 'change' && card.undo_id === id) card.state = 'undone';
  }
  return row;
}
