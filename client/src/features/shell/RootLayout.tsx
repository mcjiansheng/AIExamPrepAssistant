// 根布局：断点、外观与动效设置、事件流、全局弹层（登录、连接 AI、用量确认）、撤销条和离线条。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useApiMode } from '../../App';
import { connectEvents } from '../../api/events';
import { useMe, useSettings } from '../../api/hooks';
import { money, tokens } from '../../lib/format';
import { useBreakpoint } from '../../state/breakpoint';
import { useSession } from '../../state/session';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Button } from '../../ui/Button';
import { OfflineBar, UndoBar } from '../../ui/Feedback';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { Column } from '../../layout';
import { ConnectFlow } from '../ai/ConnectFlow';
import { LoginForm } from '../auth/LoginForm';

const APPEARANCE = 'fullgrid.appearance';

function applyAppearance(theme: string, motion: string) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  const reduce = motion === 'on' || (motion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  root.dataset.motion = reduce ? 'reduce' : 'full';
}

export function RootLayout() {
  const bp = useBreakpoint();
  const access = useSession((st) => st.access);
  const mode = useApiMode();
  const qc = useQueryClient();
  const settings = useSettings();
  useEffect(() => { document.documentElement.dataset.bp = bp; }, [bp]);
  useEffect(() => {
    const saved = JSON.parse(localStorage.getItem(APPEARANCE) ?? '{}') as { theme?: string; motion?: string };
    const theme = settings.data?.theme ?? saved.theme ?? 'system';
    const motion = settings.data?.reduce_motion ?? saved.motion ?? 'system';
    applyAppearance(theme, motion);
    if (settings.data) localStorage.setItem(APPEARANCE, JSON.stringify({ theme, motion }));
  }, [settings.data]);
  useEffect(() => {
    if (!access) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void connectEvents(qc, access, mode).then((fn) => { if (cancelled) fn(); else stop = fn; });
    return () => { cancelled = true; stop?.(); };
  }, [access, mode, qc]);
  return (
    <>
      <ScrollRestoration />
      <Outlet />
      <OfflineBar />
      <UndoBar />
      <GlobalDialogs />
    </>
  );
}

export function AuthGuard() {
  const access = useSession((st) => st.access);
  const setUser = useSession((st) => st.setUser);
  const location = useLocation();
  const me = useMe();
  useEffect(() => { if (me.data) setUser(me.data); }, [me.data, setUser]);
  const user = me.data ?? useSession.getState().user;
  if (!access) return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  // 新用户先走首次引导；新建课程向导是引导的第 2 步，不拦
  const inOnboarding = location.pathname === '/onboarding' || location.pathname === '/courses/new';
  if (user && !user.guest && user.onboarding.ai === null && user.onboarding.course === null && !inOnboarding) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Outlet />;
}

function GlobalDialogs() {
  const qc = useQueryClient();
  const login = useUi((st) => st.login);
  const connect = useUi((st) => st.connect);
  const estimate = useUi((st) => st.estimate);
  const { finishLogin, finishConnect, finishEstimate } = useUi.getState();
  return (
    <>
      <Sheet open={!!login} onClose={() => finishLogin(false)} title={s.auth.loginToSave}>
        <LoginForm onDone={() => { void qc.invalidateQueries(); finishLogin(true); }} />
      </Sheet>
      <Sheet open={!!connect} onClose={() => finishConnect(false)} title={s.ai.title} size="full">
        <ConnectFlow onDone={() => { void qc.invalidateQueries(); finishConnect(true); }} />
      </Sheet>
      <Sheet
        open={!!estimate}
        onClose={() => finishEstimate(false)}
        title="这次会用较多 token"
        footer={<><Button variant="neutral" onClick={() => finishEstimate(false)}>{s.action.cancel}</Button><Button variant="primary" onClick={() => finishEstimate(true)}>{s.action.continue}</Button></>}
      >
        {estimate && (
          <Column gap={8}>
            <Text variant="h2">约 {tokens(estimate.estimate.tokens_min)}–{tokens(estimate.estimate.tokens_max)} token</Text>
            <Text tone="secondary">
              {estimate.estimate.cost_min !== null ? `按服务商价格约 ${money(estimate.estimate.cost_min)}–${money(estimate.estimate.cost_max)}，` : ''}花的是你自己的额度。
            </Text>
          </Column>
        )}
      </Sheet>
    </>
  );
}
