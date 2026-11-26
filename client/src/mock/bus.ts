// 演示后端的事件流：代替 GET /events（SSE），按用户分发。
import type { Area, ID, ServerEvent } from '../api/types';

type Listener = (event: ServerEvent) => void;
const listeners = new Map<ID, Set<Listener>>();

export function subscribeUser(userId: ID, listener: Listener) {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

export function emit(userId: ID, event: ServerEvent) {
  for (const listener of listeners.get(userId) ?? []) queueMicrotask(() => listener(event));
}

export function changed(userId: ID, areas: Area[], courseId: ID | null = null) {
  emit(userId, { type: 'changed', areas, course_id: courseId });
}
