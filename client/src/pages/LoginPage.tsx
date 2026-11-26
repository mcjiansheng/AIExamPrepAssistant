// 登录页：手机号验证码；平板和电脑可扫码（05 第 2 节）。新用户登录后进首次引导。
import { Navigate, useLocation, useNavigate } from 'react-router';
import { LoginForm } from '../features/auth/LoginForm';
import css from '../features/auth/welcome.module.css';
import { Logo } from '../features/shell/AppShell';
import { useSession } from '../state/session';
import { s } from '../strings/zh-CN';
import { IconButton } from '../ui/Button';
import { Text } from '../ui/Text';
import { Row } from '../layout';

export function LoginPage() {
  const access = useSession((st) => st.access);
  const user = useSession((st) => st.user);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (access && user && !user.guest) return <Navigate to={from} replace />;
  return (
    <main className={css.screen}>
      <div className={css.loginBox}>
        <Row gap={8}>
          <IconButton icon="back" label={s.action.back} to="/welcome" />
          <Logo size={24} />
          <Text variant="h2" as="h1">{s.action.login}{s.app.name}</Text>
        </Row>
        <LoginForm onDone={(tokens) => navigate(tokens.is_new ? '/onboarding' : from, { replace: true })} />
      </div>
    </main>
  );
}
