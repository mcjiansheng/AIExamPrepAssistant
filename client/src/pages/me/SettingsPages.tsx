// 设置的二级页面：提醒、复习强度、外观、助手、账号与安全、数据、关于与协议、反馈（06 第 16 节、05 第 7–9 节）。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiMode } from '../../App';
import { api } from '../../api/endpoints';
import { errorText, invalidate, useApply, useDevices, useMe, useMemory, useReminders, useSettings } from '../../api/hooks';
import { switchApi } from '../../api/setup';
import type { Intensity, Reminders, Settings } from '../../api/types';
import { ago, longDate } from '../../lib/format';
import { useSession } from '../../state/session';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Notice } from '../../ui/Blocks';
import { Button, IconButton } from '../../ui/Button';
import { Tag } from '../../ui/Chip';
import { Skeleton } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import type { IconName } from '../../ui/icons';
import { Segmented, Switch, TextArea, TextField } from '../../ui/Inputs';
import { ConfirmDialog } from '../../ui/Sheet';
import { Page, Section } from '../../ui/Page';
import { Group, ListItem } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';

function useSetting() {
  const apply = useApply();
  return (patch: Partial<Settings>) => void apply(() => api.updateSettings(patch), { undo: false }).catch(() => undefined);
}

function Check({ on }: { on: boolean }) {
  return on ? <Icon name="check" tone="accent" label="已选择" /> : <span style={{ width: 20 }} />;
}

export function RemindersPage() {
  const qc = useQueryClient();
  const reminders = useReminders();
  const [r, setR] = useState<Reminders | null>(null);
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  useEffect(() => { if (reminders.data) setR(reminders.data); }, [reminders.data]);
  const save = async (next: Reminders) => {
    setR(next);
    try { await api.setReminders(next); invalidate(qc, ['notifications']); void reminders.refetch(); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); }
  };
  return (
    <Page back="/me" title={s.me.reminders} width="reading">
      {!r ? <Skeleton height={180} radius={20} /> : (
        <>
          <Group>
            <ListItem icon="clock" title={s.reminders.daily} subtitle="提醒今天还剩几项任务" trailing={<Switch label={s.reminders.daily} checked={r.daily.enabled} onChange={(v) => void save({ ...r, daily: { ...r.daily, enabled: v } })} />} />
            {r.daily.enabled && (
              <div style={{ padding: '0 16px 12px 56px' }}>
                <TextField label={s.reminders.time} value={r.daily.time} onChange={(v) => v && void save({ ...r, daily: { ...r.daily, time: v } })} type="time" />
              </div>
            )}
            <ListItem icon="flag" title={s.reminders.exam} subtitle="考前 3 天、前 1 天" trailing={<Switch label={s.reminders.exam} checked={r.exam_soon} onChange={(v) => void save({ ...r, exam_soon: v })} />} />
            <ListItem icon="checkCircle" title={s.reminders.jobs} trailing={<Switch label={s.reminders.jobs} checked={r.jobs} onChange={(v) => void save({ ...r, jobs: v })} />} />
          </Group>
          {permission === 'default' && (
            <Group>
              <ListItem icon="bell" title="允许浏览器通知" subtitle="离开页面时也能收到提醒" trailing={<Button size="sm" variant="secondary" onClick={async () => setPermission(await Notification.requestPermission())}>允许</Button>} />
            </Group>
          )}
          {permission === 'denied' && <Notice tone="warn" icon="warning">浏览器通知已被关闭，可以在浏览器的网站设置里打开</Notice>}
        </>
      )}
    </Page>
  );
}

export function IntensityPage() {
  const settings = useSettings();
  const set = useSetting();
  return (
    <Page back="/me" title={s.me.intensity} width="reading">
      <Group>
        {(['easy', 'standard', 'sprint'] as Intensity[]).map((v) => (
          <ListItem key={v} title={s.intensity[v]} subtitle={s.intensityNote[v]} trailing={<Check on={settings.data?.intensity === v} />} onClick={() => set({ intensity: v })} />
        ))}
      </Group>
    </Page>
  );
}

export function AppearancePage() {
  const settings = useSettings();
  const set = useSetting();
  const d = settings.data;
  return (
    <Page back="/me" title={s.me.appearance} width="reading">
      <Group title="颜色">
        {(['system', 'light', 'dark'] as const).map((v) => (
          <ListItem key={v} icon={v === 'dark' ? 'moon' : v === 'light' ? 'sun' : 'palette'} title={s.theme[v]} trailing={<Check on={d?.theme === v} />} onClick={() => set({ theme: v })} />
        ))}
      </Group>
      <Group title="动态效果">
        {(['system', 'off', 'on'] as const).map((v) => (
          <ListItem key={v} title={v === 'on' ? '减少动态效果' : v === 'off' ? '正常' : s.motion.system} trailing={<Check on={d?.reduce_motion === v} />} onClick={() => set({ reduce_motion: v })} />
        ))}
      </Group>
    </Page>
  );
}

export function AssistantSettingsPage() {
  const qc = useQueryClient();
  const settings = useSettings();
  const memory = useMemory();
  const set = useSetting();
  const [clearing, setClearing] = useState(false);
  const d = settings.data;
  return (
    <Page back="/me" title={s.me.assistant} width="reading">
      {d && (
        <Group>
          <ListItem icon="brain" title="记住我的习惯" subtitle="作息、偏好、难点，只记你说过的或作答里明确的" trailing={<Switch label="记忆" checked={d.memory} onChange={(v) => set({ memory: v })} />} />
          <ListItem icon="hint" title="卡住时主动提示" subtitle="同一题停留 3 分钟，或连续答错 2 次" trailing={<Switch label="主动提示" checked={d.proactive_hints} onChange={(v) => set({ proactive_hints: v })} />} />
          <ListItem icon="assistant" title="每日简报" subtitle="每天第一次打开时，今天页顶部的两三句话" trailing={<Switch label="每日简报" checked={d.briefing} onChange={(v) => set({ briefing: v })} />} />
        </Group>
      )}
      <Section title="助手记住的事" action={(memory.data?.length ?? 0) > 0 ? <Button variant="text" size="sm" onClick={() => setClearing(true)}>清空</Button> : undefined}>
        <Group>
          {memory.isLoading ? <Skeleton height={56} /> : (memory.data ?? []).length === 0 ? <ListItem title="还没有记住任何事" /> : memory.data!.map((m) => (
            <ListItem key={m.id} title={m.text} subtitle={`${m.source === 'user' ? '你说的' : '从作答得出'} · ${ago(m.created_at)}`}
              trailing={<IconButton icon="trash" label={`忘记：${m.text}`} size="sm" onClick={async () => { await api.forget(m.id); void qc.invalidateQueries({ queryKey: ['memory'] }); }} />} />
          ))}
        </Group>
      </Section>
      <ConfirmDialog open={clearing} title="清空助手的记忆？" body="助手会忘掉记住的全部习惯和偏好。" confirm="清空" danger onCancel={() => setClearing(false)}
        onConfirm={async () => { setClearing(false); await api.forgetAll(); void qc.invalidateQueries({ queryKey: ['memory'] }); }} />
    </Page>
  );
}

const DEVICE_ICON: Record<string, IconName> = { phone: 'phone', tablet: 'tablet', desktop: 'laptop', browser: 'laptop' };

export function AccountPage() {
  const me = useMe();
  const devices = useDevices();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const signOut = useSession((st) => st.signOut);
  return (
    <Page back="/me" title={s.me.account} width="reading">
      <Group>
        <ListItem icon="phone" title={s.account.phone} value={me.data?.phone_masked ?? '未绑定'} />
        <ListItem icon="shield" title={s.account.huawei} subtitle={s.account.huaweiNote} value={s.account.unbound} />
      </Group>
      <Group title={s.account.devices}>
        {devices.isLoading ? <Skeleton height={56} /> : (devices.data ?? []).map((d) => (
          <ListItem key={d.id} icon={DEVICE_ICON[d.kind] ?? 'laptop'} iconTone="neutral" title={d.name} subtitle={ago(d.last_seen)}
            trailing={d.current ? <Tag tone="accent">{s.account.current}</Tag> : <Button size="sm" variant="neutral" onClick={async () => { await api.removeDevice(d.id); void devices.refetch(); }}>{s.account.signOutDevice}</Button>} />
        ))}
      </Group>
      <Row justify="center">
        <Button variant="text" icon="logout" onClick={async () => { await api.logout().catch(() => undefined); signOut(); qc.clear(); navigate('/welcome', { replace: true }); }}>{s.action.logout}</Button>
      </Row>
    </Page>
  );
}

export function DataPage() {
  const mode = useApiMode();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const signOut = useSession((st) => st.signOut);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'reset' | null>(null);
  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId!), enabled: !!jobId, refetchInterval: (q) => (q.state.data?.status === 'done' || q.state.data?.status === 'failed' ? false : 1000) });
  const deletion = me.data?.deletion_at;
  return (
    <Page back="/me" title={s.me.data} width="reading">
      <Group>
        <ListItem icon="download" title={s.data.export} subtitle="课程、资料原件、笔记、作答记录、对话"
          trailing={job.data?.status === 'done' && job.data.result?.url
            ? <a href={job.data.result.url} download="满格数据导出.json"><Button size="sm" variant="secondary" icon="download">{s.data.download}</Button></a>
            : <Button size="sm" variant="secondary" loading={!!jobId && job.data?.status !== 'done'} onClick={async () => setJobId((await api.exportData()).id)}>{jobId ? s.data.exporting : '导出'}</Button>} />
      </Group>
      <Group>
        {deletion ? (
          <ListItem icon="warning" iconTone="danger" title={`账号将在 ${longDate(deletion.slice(0, 10))} 删除`} subtitle="在这之前可以撤销"
            trailing={<Button size="sm" variant="secondary" onClick={async () => { await api.restoreAccount(); void me.refetch(); }}>{s.data.restore}</Button>} />
        ) : (
          <ListItem icon="trash" iconTone="danger" title={s.data.delete} danger onClick={() => setConfirm('delete')} />
        )}
      </Group>
      {mode === 'mock' && (
        <Section title="演示">
          <Group>
            <ListItem icon="retry" title={s.data.reset} subtitle="清除这台浏览器里的演示数据，回到欢迎页" onClick={() => setConfirm('reset')} />
          </Group>
        </Section>
      )}
      <Section title={s.data.api}>
        <Column gap={8}>
          <Segmented label={s.data.api} value={localStorage.getItem('fullgrid.api') ?? 'auto'} onChange={(v) => switchApi(v as 'mock' | 'real' | 'auto')}
            options={[{ value: 'auto', label: '自动' }, { value: 'real', label: '服务端' }, { value: 'mock', label: '演示数据' }]} />
          <Text variant="caption" tone="tertiary">当前：{mode === 'mock' ? '演示数据（浏览器内）' : '服务端'}</Text>
        </Column>
      </Section>
      <ConfirmDialog open={confirm === 'delete'} title={s.data.deleteTitle} body={s.data.deleteBody} confirm="注销" danger onCancel={() => setConfirm(null)}
        onConfirm={async () => { setConfirm(null); try { await api.deleteAccount(); void me.refetch(); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } }} />
      <ConfirmDialog open={confirm === 'reset'} title="重置演示数据？" body="这台浏览器里的演示课程、作答和设置都会清空。" confirm="重置" danger onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          const { resetMockData } = await import('../../mock');
          resetMockData();
          signOut();
          qc.clear();
          localStorage.removeItem('fullgrid.welcome.played');
          navigate('/welcome', { replace: true });
          location.reload();
        }} />
    </Page>
  );
}

const LEGAL: { id: string; title: string; body: string[] }[] = [
  { id: 'terms', title: '用户协议', body: [
    '满格是大学生鸿蒙开发课程的作品，当前为测试版本，不对外收费。',
    '你上传的资料应当是你有权使用的学习资料；生成的讲解和题目仅供个人复习，可能有错误，以课件和老师的说法为准。',
    '正式上线前，本协议会由团队按相关法规补充完整后重新征得你的同意。',
  ] },
  { id: 'privacy', title: '隐私政策', body: [
    '我们收集：手机号（登录）、你创建的课程和上传的资料、作答和学习记录、与助手的对话、你填写的模型密钥（加密保存，不会返回给任何客户端）。',
    '这些信息只用于为你本人提供复习计划、出题、讲解和多设备同步，不出售、不用于训练模型。',
    '你可以随时导出全部数据，或注销账号；注销 7 天后数据会被删除，包括模型密钥。',
  ] },
  { id: 'data', title: '资料处理说明', body: [
    '整理资料、出题、核对和对话时，课件、照片和对话内容会发送给你自己选择并连接的模型服务商处理，按该服务商的规则收费和保存。',
    '文字识别在满格的服务端完成，图片不发给第三方；示例课程不调用任何模型。',
  ] },
];

export function AboutPage() {
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 200);
  }, []);
  return (
    <Page back="/me" title={s.me.about} width="reading">
      <Group><ListItem icon="info" title={s.app.name} value="v0.1 测试版" /></Group>
      {LEGAL.map((section) => (
        <Section key={section.id} id={section.id} title={section.title}>
          <Group padded><Column gap={12}>{section.body.map((p, i) => <Text key={i} variant="bodySm" tone="secondary">{p}</Text>)}</Column></Group>
        </Section>
      ))}
    </Page>
  );
}

export function FeedbackPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<'bug' | 'idea' | 'report'>('bug');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Page back="/me" title={s.me.feedback} width="reading">
      <Segmented label="反馈类型" value={kind} onChange={setKind} options={[{ value: 'bug', label: '问题' }, { value: 'idea', label: '建议' }, { value: 'report', label: '举报内容' }]} />
      <TextArea label="内容" hideLabel value={text} onChange={setText} placeholder={kind === 'report' ? '哪道题或哪段讲解有问题？' : '遇到了什么，或希望它怎么做'} minRows={6} />
      <Button variant="primary" size="lg" loading={busy} disabled={!text.trim()} onClick={async () => {
        setBusy(true);
        try { await api.feedback(kind, text.trim(), location.pathname); useUi.getState().toast('已收到，谢谢'); navigate('/me'); }
        catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
      }}>{s.action.submit}</Button>
    </Page>
  );
}
