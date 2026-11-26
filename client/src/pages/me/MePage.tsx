// 我的：头像昵称、本周学习、设置入口（06 第 16 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { useMe, usePlugins, useProviders, useSettings, useStats } from '../../api/hooks';
import { usePageContext } from '../../features/assistant/context';
import { duration } from '../../lib/format';
import { useSession } from '../../state/session';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Button } from '../../ui/Button';
import { Avatar } from '../../ui/Chip';
import { Page } from '../../ui/Page';
import { Card, Group, ListItem } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';

export function MePage() {
  const me = useMe();
  const stats = useStats();
  const settings = useSettings();
  const providers = useProviders();
  const plugins = usePlugins();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const signOut = useSession((st) => st.signOut);
  usePageContext({ route: '/me', chips: [] });
  const user = me.data;
  const connected = providers.data?.find((p) => p.status === 'ok');
  const enabled = plugins.data?.filter((p) => p.installed && p.enabled).length ?? 0;
  const logout = async () => {
    await api.logout().catch(() => undefined);
    signOut();
    qc.clear();
    navigate('/welcome', { replace: true });
  };
  return (
    <Page title={s.me.title} large>
      <Card>
        <Row gap={16}>
          <Avatar name={user?.nickname ?? '我'} />
          <Column gap={2} grow>
            <Text variant="h2">{user?.nickname ?? ' '}</Text>
            <Text variant="caption" tone="secondary">{user?.guest ? s.auth.guestBanner : user?.phone_masked ?? ''}</Text>
          </Column>
          {user?.guest && <Button variant="primary" size="sm" onClick={() => void useUi.getState().requestLogin()}>{s.action.login}</Button>}
        </Row>
        {stats.data && (
          <Row gap={24} padding={[8, 0]}>
            <Column gap={0}><Text variant="caption" tone="secondary">{s.me.week}</Text><Text variant="h3">{duration(stats.data.week_minutes)}</Text></Column>
            {stats.data.streak_days > 0 && <Column gap={0}><Text variant="caption" tone="secondary">连续学习</Text><Text variant="h3">{stats.data.streak_days} 天</Text></Column>}
          </Row>
        )}
      </Card>
      <Group>
        <ListItem icon="bot" title={s.me.ai} value={connected ? connected.name : '未连接'} to="/me/ai" />
        <ListItem icon="plugin" title={s.me.plugins} value={`${enabled} 个已启用`} to="/me/plugins" />
        <ListItem icon="bell" title={s.me.reminders} to="/me/reminders" />
      </Group>
      <Group>
        <ListItem icon="gauge" title={s.me.intensity} value={settings.data ? s.intensity[settings.data.intensity] : ''} to="/me/intensity" />
        <ListItem icon="palette" title={s.me.appearance} value={settings.data ? s.theme[settings.data.theme] : ''} to="/me/appearance" />
        <ListItem icon="assistant" title={s.me.assistant} to="/me/assistant" />
      </Group>
      <Group>
        <ListItem icon="shield" title={s.me.account} to="/me/account" />
        <ListItem icon="data" title={s.me.data} to="/me/data" />
        <ListItem icon="info" title={s.me.about} to="/me/about" />
        <ListItem icon="mail" title={s.me.feedback} to="/me/feedback" />
      </Group>
      {!user?.guest && <Row justify="center"><Button variant="text" icon="logout" onClick={() => void logout()}>{s.action.logout}</Button></Row>}
    </Page>
  );
}
