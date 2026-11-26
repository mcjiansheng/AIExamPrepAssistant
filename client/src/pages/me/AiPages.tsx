// AI 模型与用量（04 第 2–5 节）：密钥只进不出，只显示末 4 位；能力不够时说清楚影响什么，并给补齐的办法。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { errorText, invalidate, useLimits, useModels, useProviders, useUsage } from '../../api/hooks';
import type { Connection, Role } from '../../api/types';
import { ConnectFlow } from '../../features/ai/ConnectFlow';
import { money, shortDate, tokens } from '../../lib/format';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Button } from '../../ui/Button';
import { Columns, HBars } from '../../ui/Charts';
import { Tag } from '../../ui/Chip';
import { BigNumber, ErrorState, Skeleton } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Segmented, Stepper, Switch, TextField } from '../../ui/Inputs';
import { ConfirmDialog, Menu, Sheet } from '../../ui/Sheet';
import { Page, Section } from '../../ui/Page';
import { Group, ListItem } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';

const STATUS: Record<Connection['status'], { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  ok: { label: '已连接', tone: 'success' }, invalid: { label: '密钥无效', tone: 'danger' }, limited: { label: '余额不足', tone: 'warning' }, unchecked: { label: '待检查', tone: 'neutral' },
};
const ROLES: Role[] = ['chat', 'organize', 'generate', 'vision'];

export function AiModelsPage() {
  const qc = useQueryClient();
  const providers = useProviders();
  const models = useModels();
  const limits = useLimits();
  const usage = useUsage('week');
  const [adding, setAdding] = useState<'any' | 'vision' | null>(null);
  const [rekey, setRekey] = useState<Connection | null>(null);
  const [key, setKey] = useState('');
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const refresh = () => invalidate(qc, ['providers']);
  const check = async (c: Connection) => {
    try {
      const r = await api.checkProvider(c.id);
      refresh();
      useUi.getState().toast(r.connection.status === 'ok' ? s.ai.connected(c.name) : r.connection.status_message ?? '连接没有成功', r.connection.status === 'ok' ? 'default' : 'danger');
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); }
  };
  const ok = (providers.data ?? []).filter((p) => p.status === 'ok');
  const choices = (vision: boolean) => ok.flatMap((p) => p.models.filter(() => !vision || p.capabilities?.vision).map((m) => ({ connection: p, model: m })));
  const setRoles = async (roles: Role[], connection_id: string, model: string) => {
    await api.setModels(Object.fromEntries(roles.map((r) => [r, { connection_id, model }])));
    invalidate(qc, ['providers']);
  };
  const roleValue = (r: Role) => models.data?.roles[r]?.model ?? (r === 'vision' ? '未配置' : '未选择');
  const weekTokens = usage.data ? usage.data.total.tokens_in + usage.data.total.tokens_out : 0;

  if (providers.isError) return <Page back="/me" title={s.ai.title}><ErrorState error={providers.error} onRetry={() => void providers.refetch()} /></Page>;
  return (
    <Page back="/me" title={s.ai.title} width="reading">
      <Group title="服务商" action={<Button variant="text" size="sm" icon="plus" onClick={() => setAdding('any')}>{s.ai.addProvider}</Button>}>
        {providers.isLoading ? <Skeleton height={56} /> : (providers.data ?? []).length === 0 ? (
          <ListItem icon="key" title="还没有连接 AI 模型" subtitle="连接后才能整理资料、出题和使用助手" onClick={() => setAdding('any')} chevron />
        ) : (providers.data ?? []).map((p) => (
          <ListItem
            key={p.id} icon="key" title={p.name}
            subtitle={<Row gap={8} wrap><span>••••{p.key_last4}</span>{p.status_message && <span>· {p.status_message}</span>}</Row>}
            value={<Row gap={8}>{p.capabilities?.vision && <Icon name="image" size={16} tone="tertiary" label="能看图" />}<Tag tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Tag></Row>}
            trailing={<Menu items={[
              { label: '重新检查', icon: 'retry', onSelect: () => void check(p) },
              { label: '更换密钥', icon: 'key', onSelect: () => { setKey(''); setRekey(p); } },
              { label: s.action.delete, icon: 'trash', danger: true, onSelect: () => setRemoving(p) },
            ]} />}
          />
        ))}
      </Group>

      <Group title={s.ai.defaultModel}>
        <ListItem icon="bot" title={s.ai.defaultModel} value={roleValue('chat')}
          trailing={choices(false).length > 1 ? <Menu icon="chevronDown" label={s.ai.defaultModel} items={choices(false).map((c) => ({ label: `${c.connection.name} · ${c.model}`, onSelect: () => void setRoles(['chat', 'organize', 'generate'], c.connection.id, c.model) }))} /> : undefined} />
        <ListItem icon="image" title={s.ai.vision} subtitle={models.data?.roles.vision ? undefined : '图里的文字仍会识别，示意图和流程图不会被理解'}
          value={models.data?.roles.vision ? roleValue('vision') : undefined}
          trailing={models.data?.roles.vision ? undefined : <Button size="sm" variant="secondary" onClick={() => setAdding('vision')}>{s.ai.addVision}</Button>} />
        <ListItem icon="scan" title={s.ai.ocr} value={s.ai.builtin} />
        <ListItem icon="mic" title={s.ai.speech} value={s.ai.speechOff} />
        <ListItem icon="settings" title={s.ai.advanced} trailing={<Icon name={advanced ? 'chevronUp' : 'chevronDown'} tone="tertiary" />} onClick={() => setAdvanced((v) => !v)} />
        {advanced && ROLES.map((r) => (
          <ListItem key={r} title={s.ai.roles[r]} value={roleValue(r)}
            trailing={choices(r === 'vision').length > 0 ? <Menu icon="chevronDown" label={s.ai.roles[r]} items={choices(r === 'vision').map((c) => ({ label: `${c.connection.name} · ${c.model}`, onSelect: () => void setRoles([r], c.connection.id, c.model) }))} /> : undefined} />
        ))}
      </Group>

      <Group title={s.ai.usage}>
        <ListItem icon="gauge" title="最近 7 天" value={usage.data ? `${tokens(weekTokens)} token · 约 ${money(usage.data.total.cost)}` : ''} to="/me/ai/usage" />
      </Group>

      {limits.data && (
        <Group title={s.ai.limits}>
          <ListItem title={s.ai.confirmAt} trailing={
            <Stepper label={s.ai.confirmAt} value={limits.data.confirm_tokens} min={5_000} max={200_000} step={5_000} format={tokens}
              onChange={(v) => void api.setLimits({ confirm_tokens: v }).then(() => void limits.refetch())} />
          } />
          <ListItem title={s.ai.daily} subtitle={limits.data.daily_tokens ? `今天已用 ${tokens(limits.data.today_tokens)}` : '默认不设上限'} trailing={
            <Row gap={8}>
              {limits.data.daily_tokens !== null && <Stepper label={s.ai.daily} value={limits.data.daily_tokens} min={10_000} max={2_000_000} step={10_000} format={tokens} onChange={(v) => void api.setLimits({ daily_tokens: v }).then(() => void limits.refetch())} />}
              <Switch label={s.ai.daily} checked={limits.data.daily_tokens !== null} onChange={(on) => void api.setLimits({ daily_tokens: on ? 200_000 : null }).then(() => void limits.refetch())} />
            </Row>
          } />
        </Group>
      )}

      <Sheet open={!!adding} onClose={() => setAdding(null)} title={adding === 'vision' ? s.ai.addVision : s.ai.addProvider} size="full">
        {adding && <ConnectFlow visionOnly={adding === 'vision'} onDone={() => { setAdding(null); invalidate(qc, ['providers', 'materials', 'courses']); }} />}
      </Sheet>
      <Sheet open={!!rekey} onClose={() => setRekey(null)} title={`更换 ${rekey?.name ?? ''} 的密钥`}
        footer={<Button variant="primary" block disabled={key.trim().length < 8} onClick={async () => { const c = rekey!; setRekey(null); await api.updateProvider(c.id, { key: key.trim() }); await check(c); }}>{s.ai.step3}</Button>}>
        <TextField label={s.ai.keyLabel} value={key} onChange={setKey} type="password" icon="key" placeholder="sk-…" autoFocus />
      </Sheet>
      <ConfirmDialog open={!!removing} title={`删除 ${removing?.name ?? ''} 的连接？`} body="密钥立即失效，用它的功能需要换一个连接。" confirm={s.action.delete} danger
        onCancel={() => setRemoving(null)} onConfirm={async () => { const c = removing!; setRemoving(null); await api.removeProvider(c.id); refresh(); }} />
    </Page>
  );
}

export function UsagePage() {
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const usage = useUsage(period);
  const u = usage.data;
  const total = u ? u.total.tokens_in + u.total.tokens_out : 0;
  return (
    <Page back="/me/ai" title={s.me.usage} width="reading" actions={<Segmented label="时间范围" value={period} onChange={setPeriod} options={[{ value: 'week', label: '本周' }, { value: 'month', label: '本月' }]} />}>
      {usage.isError ? <ErrorState error={usage.error} onRetry={() => void usage.refetch()} /> : !u ? <Skeleton height={240} radius={20} /> : (
        <>
          <Group padded>
            <Column gap={4}>
              <Text variant="caption" tone="secondary">{period === 'week' ? '最近 7 天' : '最近 30 天'}</Text>
              <Row gap={12} align="baseline"><BigNumber value={Math.round(total / 1000)} unit="千 token" /><Text tone="secondary" as="span">约 {money(u.total.cost)}</Text></Row>
            </Column>
            <div style={{ marginTop: 16 }}>
              <Columns label="每天的 token 用量" data={u.daily.map((d) => ({ key: d.date, label: shortDate(d.date), value: d.tokens }))} format={tokens} />
            </div>
          </Group>
          <Section title="按功能">
            <Group padded><HBars format={tokens} rows={u.by_feature.map((f) => ({ key: f.feature, name: s.feature[f.feature], value: f.tokens_in + f.tokens_out }))} /></Group>
          </Section>
          <Section title="按课程">
            <Group padded><HBars format={tokens} rows={u.by_course.map((c) => ({ key: c.course_id, name: c.name, value: c.tokens_in + c.tokens_out }))} /></Group>
          </Section>
          {u.by_plugin.length > 0 && (
            <Section title="按插件">
              <Group>{u.by_plugin.map((p) => <ListItem key={p.plugin_id} icon="plugin" title={p.name} value={`${tokens(p.tokens_in + p.tokens_out)} · 约 ${money(p.cost)}`} />)}</Group>
            </Section>
          )}
          <Section title="用量较大的操作">
            <Group>{u.recent.map((r) => <ListItem key={r.id} title={r.label} subtitle={r.course_name ?? undefined} value={`${tokens(r.tokens)} · 约 ${money(r.cost)}`} />)}</Group>
          </Section>
          <Text variant="caption" tone="tertiary">金额按服务商公开价格估算，以服务商账单为准。</Text>
        </>
      )}
    </Page>
  );
}
