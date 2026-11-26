// 演示后端入口：接管请求层，启动后台任务的计时器，提供事件流。
import { setTransport } from '../api/client';
import type { ServerEvent } from '../api/types';
import { subscribeUser } from './bus';
import { db, flush, resetDb } from './db';
import { startTicker } from './jobs';
import { mockFetch } from './server';

export function installMock() {
  setTransport(mockFetch);
  startTicker();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

export function subscribeMock(accessToken: string, listener: (event: ServerEvent) => void) {
  const row = db.tokens.find((t) => t.token === accessToken && t.kind === 'access');
  if (!row) return () => {};
  return subscribeUser(row.user_id, listener);
}

export function resetMockData() {
  resetDb();
}

export { mockFetch };
