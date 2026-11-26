// 插件中心：已安装（开关、按课程启用、权限、用量）、内置可用、从链接安装（03 第 8.9 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../../api/endpoints';
import { errorText, invalidate, useCourses, usePlugin, usePlugins } from '../../api/hooks';
import type { Plugin } from '../../api/types';
import { tokens } from '../../lib/format';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Button } from '../../ui/Button';
import { Chip, Tag } from '../../ui/Chip';
import { EmptyState, ErrorState, Skeleton } from '../../ui/Feedback';
import { Segmented, Switch, TextField } from '../../ui/Inputs';
import { Sheet } from '../../ui/Sheet';
import { Page, Section } from '../../ui/Page';
import { Group, ListItem } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';

const PERMISSION: Record<string, string> = {
  'course.knowledge': '读取课程的知识结构', 'course.materials': '读取课件内容', questions: '新增题目', mistakes: '读取错题', schedule: '读取日程', search: '访问网页搜索',
};

function permissionLines(p: Plugin) {
  const lines = [...p.permissions.read.map((x) => PERMISSION[x] ?? `读取 ${x}`), ...p.permissions.write.map((x) => PERMISSION[x] ?? `写入 ${x}`), ...p.permissions.network.map((x) => PERMISSION[x] ?? `访问 ${x}`)];
  if (p.permissions.model) lines.push('使用你的模型（计入用量）');
  return lines.length ? lines : ['不需要任何权限'];
}

function InstallSheet({ plugin, onClose }: { plugin: Plugin | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={!!plugin} onClose={onClose} title={plugin ? `安装“${plugin.name}”？` : ''}
      footer={<><Button variant="neutral" onClick={onClose}>{s.action.cancel}</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try { await api.installPlugin(plugin!.id); invalidate(qc, ['plugins']); useUi.getState().toast(`已安装 ${plugin!.name}`); onClose(); }
        catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
      }}>安装</Button></>}>
      {plugin && (
        <Column gap={12}>
          <Text tone="secondary">{plugin.description}</Text>
          <Text variant="caption" tone="tertiary">它需要</Text>
          <Column gap={8}>{permissionLines(plugin).map((l) => <Text key={l} variant="bodySm">· {l}</Text>)}</Column>
          <Text variant="caption" tone="tertiary">{plugin.cost}</Text>
        </Column>
      )}
    </Sheet>
  );
}

export function PluginsPage() {
  const qc = useQueryClient();
  const plugins = usePlugins();
  const [installing, setInstalling] = useState<Plugin | null>(null);
  const [url, setUrl] = useState('');
  const installed = (plugins.data ?? []).filter((p) => p.installed);
  const available = (plugins.data ?? []).filter((p) => !p.installed);
  const toggle = async (p: Plugin, enabled: boolean) => {
    try { await api.updatePlugin(p.id, { enabled }); invalidate(qc, ['plugins']); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); }
  };
  if (plugins.isError) return <Page back="/me" title={s.me.plugins}><ErrorState error={plugins.error} onRetry={() => void plugins.refetch()} /></Page>;
  return (
    <Page back="/me" title={s.me.plugins} width="reading">
      {plugins.isLoading ? <Skeleton height={200} radius={20} /> : (
        <>
          <Group title="已安装">
            {installed.length === 0 ? <ListItem title="还没有安装插件" /> : installed.map((p) => (
              <ListItem key={p.id} icon="plugin" title={p.name} subtitle={p.description} to={`/me/plugins/${p.id}`} chevron={false}
                trailing={<span onClick={(e) => e.preventDefault()}><Switch label={`启用 ${p.name}`} checked={p.enabled} onChange={(v) => void toggle(p, v)} /></span>} />
            ))}
          </Group>
          {available.length > 0 && (
            <Group title="内置可用">
              {available.map((p) => (
                <ListItem key={p.id} icon="plugin" iconTone="neutral" title={p.name} subtitle={p.description} to={`/me/plugins/${p.id}`} chevron={false}
                  trailing={<span onClick={(e) => e.preventDefault()}><Button size="sm" variant="secondary" onClick={() => setInstalling(p)}>安装</Button></span>} />
              ))}
            </Group>
          )}
          <Section title="从链接安装">
            <Row gap={8} align="start">
              <div style={{ flex: 1 }}><TextField label="插件地址" hideLabel value={url} onChange={setUrl} placeholder="Git 仓库或插件包的网址" type="url" icon="link" /></div>
              <Button variant="secondary" size="lg" disabled={!url.trim()} onClick={async () => {
                try { await api.addPlugin(url.trim()); invalidate(qc, ['plugins']); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); }
              }}>{s.action.add}</Button>
            </Row>
          </Section>
        </>
      )}
      <InstallSheet plugin={installing} onClose={() => setInstalling(null)} />
    </Page>
  );
}

export function PluginDetailPage() {
  const { pid = '' } = useParams();
  const qc = useQueryClient();
  const plugin = usePlugin(pid);
  const courses = useCourses();
  const [installing, setInstalling] = useState<Plugin | null>(null);
  const p = plugin.data;
  const update = async (body: Parameters<typeof api.updatePlugin>[1]) => {
    try { await api.updatePlugin(pid, body); invalidate(qc, ['plugins']); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); }
  };
  if (plugin.isError) return <Page back="/me/plugins" title={s.me.plugins}><ErrorState error={plugin.error} onRetry={() => void plugin.refetch()} /></Page>;
  if (!p) return <Page back="/me/plugins" title=" "><Skeleton height={200} radius={20} /></Page>;
  return (
    <Page back="/me/plugins" title={p.name} subtitle={`${p.version} · ${p.source === 'builtin' ? '内置' : '第三方'}`} width="reading"
      actions={p.installed ? <Switch label={`启用 ${p.name}`} checked={p.enabled} onChange={(v) => void update({ enabled: v })} /> : <Button variant="primary" size="sm" onClick={() => setInstalling(p)}>安装</Button>}>
      <Group padded><Column gap={8}><Text>{p.description}</Text><Text variant="bodySm" tone="secondary">{p.readme}</Text></Column></Group>
      {p.installed && (
        <Section title="在哪些课程启用">
          <Column gap={12}>
            <Segmented label="启用范围" value={p.scope} onChange={(v) => void update({ scope: v })} options={[{ value: 'all', label: '全部课程' }, { value: 'courses', label: '指定课程' }]} />
            {p.scope === 'courses' && (
              <Row gap={8} wrap>
                {(courses.data ?? []).map((c) => {
                  const on = p.course_ids.includes(c.id);
                  return <Chip key={c.id} selected={on} onClick={() => void update({ course_ids: on ? p.course_ids.filter((x) => x !== c.id) : [...p.course_ids, c.id] })}>{c.name}</Chip>;
                })}
              </Row>
            )}
          </Column>
        </Section>
      )}
      {p.commands.length > 0 && (
        <Group title="命令">{p.commands.map((c) => <ListItem key={c.name} title={c.name} subtitle={c.description} />)}</Group>
      )}
      {p.question_types.length > 0 && (
        <Group title="题型"><div style={{ padding: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>{p.question_types.map((t) => <Tag key={t.id}>{t.name}</Tag>)}</div></Group>
      )}
      <Group title="权限">{permissionLines(p).map((l) => <ListItem key={l} title={l} icon="shield" iconTone="neutral" />)}</Group>
      <Group title="用量"><ListItem title="本月" value={p.usage_tokens ? `${tokens(p.usage_tokens)} token` : '没有调用模型'} subtitle={p.cost} /></Group>
      {!p.installed && p.commands.length === 0 && p.question_types.length === 0 && <EmptyState icon="plugin" title="安装后可以在对话里使用" />}
      <InstallSheet plugin={installing} onClose={() => setInstalling(null)} />
    </Page>
  );
}
