// 服务端事件流（GET /events，SSE）→ 失效或修补本地缓存。演示后端走内存里的事件总线。
import type { QueryClient } from '@tanstack/react-query';
import { useUi } from '../state/ui';
import { invalidate, keys } from './hooks';
import { BASE } from './client';
import type { ServerEvent, Session } from './types';

export type ApiMode = 'mock' | 'real';

function handle(qc: QueryClient, event: ServerEvent) {
  switch (event.type) {
    case 'changed':
      invalidate(qc, event.areas);
      break;
    case 'job':
      if (event.job.kind === 'ingest') invalidate(qc, ['materials', 'course', 'courses', 'map']);
      if (event.job.kind === 'focus') invalidate(qc, ['focus', 'map']);
      if (event.job.kind === 'session') void qc.invalidateQueries({ queryKey: keys.session(event.job.target_id) });
      break;
    case 'question':
      qc.setQueryData<Session>(keys.session(event.session_id), (old) => {
        if (!old) return old;
        const questions = old.questions.map((q) => (q.id === event.question.id ? event.question : q));
        const status = old.status === 'preparing' && event.question.status === 'ready' ? 'active' : old.status;
        return { ...old, status, questions };
      });
      break;
    case 'notification':
      invalidate(qc, ['notifications']);
      useUi.getState().toast(event.notification.title);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        new Notification(event.notification.title, { body: event.notification.body ?? undefined });
      }
      break;
    case 'resume':
      invalidate(qc, ['today']);
      break;
  }
}

export async function connectEvents(qc: QueryClient, token: string, mode: ApiMode): Promise<() => void> {
  if (mode === 'mock') {
    const { subscribeMock } = await import('../mock');
    return subscribeMock(token, (e) => handle(qc, e));
  }
  let source: EventSource | null = null;
  let closed = false;
  let delay = 1000;
  const open = () => {
    if (closed) return;
    source = new EventSource(`${BASE}/events?access_token=${encodeURIComponent(token)}`);
    source.onopen = () => {
      if (delay > 1000) invalidate(qc, ['today', 'courses', 'course', 'map', 'materials', 'practice', 'notifications']);
      delay = 1000;
    };
    source.onmessage = (message) => {
      try {
        handle(qc, JSON.parse(message.data as string) as ServerEvent);
      } catch {
        /* 忽略不认识的事件 */
      }
    };
    source.onerror = () => {
      source?.close();
      delay = Math.min(delay * 2, 30_000);
      setTimeout(open, delay);
    };
  };
  open();
  return () => {
    closed = true;
    source?.close();
  };
}
