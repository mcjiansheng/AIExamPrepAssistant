// 启动时决定连真实后端还是演示后端，并把请求层的拦截接到界面上（10 第 8.3、8.4 节）。
import { useSession } from '../state/session';
import { useUi } from '../state/ui';
import { configureClient } from './client';
import { api } from './endpoints';
import type { ApiMode } from './events';

const PREF = 'fullgrid.api';

export async function setupApi(): Promise<ApiMode> {
  const param = new URLSearchParams(location.search).get('api');
  if (param === 'mock' || param === 'real' || param === 'auto') localStorage.setItem(PREF, param);
  const pref = param ?? localStorage.getItem(PREF) ?? 'auto';
  let mode: ApiMode = 'mock';
  if (pref === 'real') mode = 'real';
  else if (pref === 'auto') {
    try {
      const response = await fetch('/api/v1/health', { signal: AbortSignal.timeout(1500) });
      const body = response.ok ? ((await response.json()) as { ok?: boolean }) : null;
      if (body?.ok) mode = 'real';
    } catch {
      /* 没有后端：用演示后端 */
    }
  }
  if (mode === 'mock') {
    const { installMock } = await import('../mock');
    installMock();
  }
  let refreshing: Promise<boolean> | null = null;
  configureClient({
    accessToken: () => useSession.getState().access,
    refresh: () => {
      const token = useSession.getState().refresh;
      if (!token) return Promise.resolve(false);
      refreshing ??= api.refresh(token)
        .then((tokens) => { useSession.getState().signIn(tokens); return true; })
        .catch(() => false)
        .finally(() => { refreshing = null; });
      return refreshing;
    },
    signedOut: () => useSession.getState().signOut(),
    loginRequired: () => useUi.getState().requestLogin(),
    aiRequired: () => useUi.getState().requestConnect(),
    confirmEstimate: (estimate) => useUi.getState().requestEstimate(estimate),
    network: (online) => useUi.getState().setOffline(!online),
  });
  return mode;
}

export function switchApi(mode: 'mock' | 'real' | 'auto') {
  localStorage.setItem(PREF, mode);
  location.reload();
}
