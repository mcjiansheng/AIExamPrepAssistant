// 资料：上传（文件、拖入、拍照、用手机拍）、列表、原页浏览器。自动判断的结果一行显示，带“改”（06 第 8 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api/endpoints';
import { errorText, invalidate, useApply, useCourse, useMaterials } from '../api/hooks';
import type { Material, MaterialKind } from '../api/types';
import { usePageContext } from '../features/assistant/context';
import css from '../features/materials/page.module.css';
import { PageBrowser } from '../features/materials/PageBrowser';
import { QrPattern } from '../features/auth/QrPattern';
import { confirmIngest, OrganizingNotice } from '../features/course/CourseParts';
import { cx } from '../lib/cx';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { Tag } from '../ui/Chip';
import { EmptyState, ErrorState, ProgressBar, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import type { IconName } from '../ui/icons';
import { ConfirmDialog, Menu, Sheet } from '../ui/Sheet';
import { Page, Section, Split } from '../ui/Page';
import { Group, ListItem } from '../ui/Surfaces';
import { Text } from '../ui/Text';
import { Column, Row } from '../layout';

const KIND_ICON: Record<MaterialKind, IconName> = { slides: 'file', homework: 'edit', notes: 'compose', review: 'flag', past_paper: 'mock', photo: 'image', other: 'file' };
const ACCEPT = '.pdf,.ppt,.pptx,.doc,.docx,.txt,.md,image/*';

export function MaterialsPage() {
  const { cid = '' } = useParams();
  const bp = useBreakpoint();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const apply = useApply();
  const course = useCourse(cid);
  const materials = useMaterials(cid);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [kindFor, setKindFor] = useState<Material | null>(null);
  const [deleting, setDeleting] = useState<Material | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [showOld, setShowOld] = useState(false);
  usePageContext(course.data ? { route: `/c/${cid}/materials`, course_id: cid, chips: [{ key: 'course_id', label: `${course.data.name} · 资料` }] } : null);

  const upload = async (files: File[], source: 'file' | 'photo' = 'file') => {
    if (!files.length) return;
    try {
      const r = await api.upload(cid, files, source);
      invalidate(qc, ['materials', 'course', 'courses']);
      const paused = r.job?.status === 'needs_input';
      const started = paused ? await confirmIngest(r.job) : !!r.job;
      if (paused) invalidate(qc, ['materials', 'course', 'courses']);
      const tail = !r.job ? s.materials.waitingAi : started ? '正在整理' : s.materials.waitingConfirm;
      useUi.getState().toast(`已添加 ${files.length} 份，${tail}`);
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); }
  };
  useEffect(() => {
    if (isCompact(bp)) return;
    let depth = 0;
    const enter = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { depth += 1; setDragging(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => { e.preventDefault(); depth = 0; setDragging(false); void upload([...(e.dataTransfer?.files ?? [])]); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const list = materials.data ?? [];
  const active = list.filter((m) => !m.superseded_by);
  const old = list.filter((m) => m.superseded_by);
  const firstReady = active.find((m) => m.status === 'ready');
  const current = selected ?? firstReady?.id ?? null;
  const open = (m: Material) => {
    if (m.status !== 'ready') return;
    if (isCompact(bp)) navigate(`/m/${m.id}/p/1?c=${cid}`);
    else { setSelected(m.id); setPage(1); }
  };

  const row = (m: Material) => (
    <div key={m.id} className={cx(css.material, current === m.id && !isCompact(bp) && css.selected)}>
      <span className={css.kindIcon}><Icon name={KIND_ICON[m.kind]} size={18} /></span>
      <Column gap={4} grow>
        <button type="button" onClick={() => open(m)} style={{ textAlign: 'left' }} disabled={m.status !== 'ready'}>
          <Text variant="h3" nowrap>{m.title}</Text>
        </button>
        <Row gap={8} wrap>
          <Tag>{s.materialKind[m.kind]}</Tag>
          {m.pages ? <Text variant="caption" tone="secondary" as="span">{s.materials.pages(m.pages)}</Text> : null}
          {m.status === 'ready' && m.kp_count !== null && <Text variant="caption" tone="secondary" as="span">· {s.materials.kps(m.kp_count)}</Text>}
        </Row>
        {(m.status === 'reading' || m.status === 'extracting') && <Column gap={4}><Text variant="caption" tone="accent">{m.stage ?? '整理中'}</Text><ProgressBar value={m.progress ?? 0} label={m.stage ?? ''} /></Column>}
        {m.status === 'waiting_ai' && <Text variant="caption" tone="warning">{s.materials.waitingAi}</Text>}
        {m.status === 'waiting_confirm' && <Text variant="caption" tone="warning">{s.materials.waitingConfirm}</Text>}
        {m.status === 'failed' && m.error && (
          <Row gap={8} wrap><Text variant="caption" tone="danger">{m.error.message}</Text><Button size="sm" variant="text" onClick={() => fileInput.current?.click()}>{s.action.reupload}</Button></Row>
        )}
        {m.skipped_pages.length > 0 && (
          <Row gap={8} wrap><Text variant="caption" tone="warning">{s.materials.skipped(m.skipped_pages)}</Text><Button size="sm" variant="text" onClick={() => fileInput.current?.click()}>{s.action.reupload}</Button></Row>
        )}
        {m.decision && (
          <Row gap={2}>
            <Text variant="caption" tone="secondary" as="span">{m.decision.options.find((o) => o.id === m.decision!.choice)?.id === m.decision.options[0]?.id ? m.decision.text : m.decision.options.find((o) => o.id === m.decision!.choice)?.label}</Text>
            <Menu icon="edit" label={s.action.change} items={m.decision.options.map((o) => ({ label: o.label, icon: o.id === m.decision!.choice ? 'check' : undefined, onSelect: () => void apply(() => api.decide(m.id, o.id)) }))} />
          </Row>
        )}
      </Column>
      <Menu items={[
        { label: s.materials.kindTitle, icon: 'edit', onSelect: () => setKindFor(m) },
        { label: s.action.delete, icon: 'trash', danger: true, onSelect: () => setDeleting(m) },
      ]} />
    </div>
  );

  const uploadButtons = (
    <Row gap={8} wrap>
      <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>{s.action.addMaterial}</Button>
      {isCompact(bp)
        ? <Button variant="secondary" icon="camera" onClick={() => photoInput.current?.click()}>{s.materials.photo}</Button>
        : <Button variant="secondary" icon="phone" onClick={async () => setPhone((await api.photoLink(cid)).url)}>{s.materials.phone}</Button>}
    </Row>
  );

  const listBlock = (
    <Column gap={16}>
      {uploadButtons}
      {course.data && <OrganizingNotice course={course.data} />}
      {materials.isError ? <ErrorState error={materials.error} onRetry={() => void materials.refetch()} />
        : materials.isLoading ? <Column gap={8}>{[0, 1, 2].map((i) => <Skeleton key={i} height={72} radius={16} />)}</Column>
        : active.length === 0 ? <EmptyState icon="file" title={s.materials.empty} />
        : <Group>{active.map(row)}</Group>}
      {old.length > 0 && (
        <Section>
          <Button variant="text" size="sm" iconRight={showOld ? 'chevronUp' : 'chevronDown'} onClick={() => setShowOld((v) => !v)}>{s.materials.superseded} {old.length}</Button>
          {showOld && <Group>{old.map(row)}</Group>}
        </Section>
      )}
    </Column>
  );

  return (
    <Page back={`/c/${cid}`} title={s.materials.title} subtitle={course.data?.name}>
      {isCompact(bp) || !current ? listBlock : (
        <Split main={listBlock} side={<PageBrowser materialId={current} page={page} onPage={setPage} courseId={cid} />} ratio="1fr 1fr" stickySide />
      )}
      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void upload([...(e.target.files ?? [])], 'photo'); e.target.value = ''; }} />
      {dragging && <div className={css.drop}>{s.materials.drop}</div>}
      <Sheet open={!!kindFor} onClose={() => setKindFor(null)} title={s.materials.kindTitle}>
        {kindFor && (
          <div>
            {(Object.keys(s.materialKind) as MaterialKind[]).map((k) => (
              <ListItem key={k} title={s.materialKind[k]} icon={KIND_ICON[k]} trailing={kindFor.kind === k ? <Icon name="check" tone="accent" /> : undefined}
                onClick={() => { const m = kindFor; setKindFor(null); void apply(() => api.setMaterialKind(m.id, k)); }} />
            ))}
          </div>
        )}
      </Sheet>
      <ConfirmDialog
        open={!!deleting} title={deleting ? s.materials.deleteTitle(deleting.title) : ''} body={deleting ? s.materials.deleteBody(deleting.kp_count ?? 0, deleting.question_count) : ''}
        confirm={s.action.delete} danger onCancel={() => setDeleting(null)}
        onConfirm={async () => { const m = deleting!; setDeleting(null); try { await api.deleteMaterial(m.id); invalidate(qc, ['materials', 'map', 'course', 'courses', 'today']); useUi.getState().toast('已删除'); if (selected === m.id) setSelected(null); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } }}
      />
      <Sheet open={!!phone} onClose={() => setPhone(null)} title={s.materials.phone}>
        {phone && (
          <Column gap={16} align="center">
            <div style={{ padding: 16, borderRadius: 20, background: '#fff' }}><QrPattern seed={phone} size={184} /></div>
            <Text tone="secondary" center>用手机上的满格扫一扫，拍完直接传到这门课</Text>
          </Column>
        )}
      </Sheet>
    </Page>
  );
}
