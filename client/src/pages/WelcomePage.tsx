// 欢迎：10 秒内知道这是什么，并能马上看到东西（06 第 1 节）。
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import css from '../features/auth/welcome.module.css';
import { Logo } from '../features/shell/AppShell';
import { cx } from '../lib/cx';
import { deviceInfo } from '../lib/device';
import { useSession } from '../state/session';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { Text } from '../ui/Text';

const PLAYED = 'fullgrid.welcome.played';
const CELLS = 32;

export function WelcomePage() {
  const access = useSession((st) => st.access);
  const signIn = useSession((st) => st.signIn);
  const navigate = useNavigate();
  const [play] = useState(() => {
    const first = !localStorage.getItem(PLAYED);
    localStorage.setItem(PLAYED, '1');
    return first;
  });
  const [busy, setBusy] = useState(false);
  if (access) return <Navigate to="/" replace />;
  const sample = async () => {
    setBusy(true);
    try {
      signIn(await api.guest(deviceInfo()));
      navigate('/', { replace: true });
    } catch {
      useUi.getState().toast('暂时进不去，请重试', 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className={css.screen}>
      <div className={cx(css.map, play && css.play)} aria-hidden>
        {Array.from({ length: CELLS }, (_, i) => (
          <span key={i} className={cx(css.cell, i === CELLS - 3 ? css.almost : css.lit)} style={play ? { animationDelay: `${Math.round((i / CELLS) * 900)}ms` } : undefined} />
        ))}
      </div>
      <div className={css.brand}>
        <Logo size={40} />
        <h1 className={css.word}>{s.app.name}</h1>
        <Text tone="secondary">{s.app.intro}</Text>
      </div>
      <div className={css.actions}>
        <Button variant="primary" size="lg" block to="/login">{s.auth.start}</Button>
        <Button variant="text" loading={busy} onClick={() => void sample()}>{s.auth.sample}</Button>
      </div>
      <p className={css.foot}>{s.app.slogan}</p>
    </main>
  );
}
