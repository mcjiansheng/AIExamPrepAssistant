// 站内通知：整理完成、考试临近、每日提醒（05 第 7 节）。点开去对应页面并标为已读。
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import { invalidate, useNotifications } from '../api/hooks';
import type { Notification } from '../api/types';
import { ago } from '../lib/format';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Chip';
import { EmptyState, ErrorState, Skeleton } from '../ui/Feedback';
import type { IconName } from '../ui/icons';
import { Page } from '../ui/Page';
import { Group, ListItem } from '../ui/Surfaces';

const ICON: Record<Notification['kind'], IconName> = { job_done: 'checkCircle', job_failed: 'warning', exam_soon: 'flag', daily: 'clock', device: 'phone' };

export function NotificationsPage() {
  const list = useNotifications();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const read = async (ids?: string[]) => { await api.readNotifications(ids); invalidate(qc, ['notifications']); };
  const items = list.data?.items ?? [];
  return (
    <Page back title={s.nav.notifications} width="reading"
      actions={list.data?.unread ? <Button variant="text" size="sm" onClick={() => void read()}>全部已读</Button> : undefined}>
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        : list.isLoading ? <Skeleton height={160} radius={20} />
        : items.length === 0 ? <EmptyState icon="bell" title="没有通知" />
        : (
          <Group>
            {items.map((n) => (
              <ListItem
                key={n.id} icon={ICON[n.kind]} iconTone={n.kind === 'job_failed' ? 'danger' : n.kind === 'exam_soon' ? 'warning' : 'accent'}
                title={n.title} subtitle={[n.body, ago(n.created_at)].filter(Boolean).join(' · ')}
                trailing={!n.read ? <Badge dot /> : undefined}
                onClick={() => { void read([n.id]); if (n.href) navigate(n.href); }}
              />
            ))}
          </Group>
        )}
    </Page>
  );
}
