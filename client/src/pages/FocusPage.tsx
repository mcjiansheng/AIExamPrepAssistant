// 老师重点与考试形式：左“老师说的”，右“对应的知识点”；边界上的知识点虚线显示，点一下选入或移除（06 第 9 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { api } from '../api/endpoints';
import { errorText, invalidate, useApply, useCourse, useExamFormat, useFocus } from '../api/hooks';
import type { ExamFormat, Fragment, QuestionType } from '../api/types';
import { usePageContext, useHighlight } from '../features/assistant/context';
import css from '../features/focus/focus.module.css';
import { cx } from '../lib/cx';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Notice } from '../ui/Blocks';
import { Button } from '../ui/Button';
import { Chip, Tag } from '../ui/Chip';
import { EmptyState, ErrorState, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { Segmented, Stepper, TextArea } from '../ui/Inputs';
import { Menu } from '../ui/Sheet';
import { Page, Section, Split } from '../ui/Page';
import { Group } from '../ui/Surfaces';
import { Text } from '../ui/Text';
import { Column, Row } from '../layout';

function levelOf(f: Fragment) {
  return f.kps[0]?.level ?? null;
}

function FragmentKps({ fragment, onInclude }: { fragment: Fragment; onInclude: (kpId: string, include: boolean | null) => void }) {
  if (!fragment.found) return <Text variant="bodySm" tone="tertiary">{s.focus.notFound}</Text>;
  const sure = fragment.kps.filter((k) => k.certainty === 'sure');
  const maybe = fragment.kps.filter((k) => k.certainty === 'maybe');
  return (
    <Column gap={12}>
      <div className={css.kps}>
        {sure.map((k) => (
          <span key={k.id} className={cx(css.kp, !k.included && css.off)}>
            {k.title}
            <button type="button" aria-label={k.included ? `移除：${k.title}` : `恢复：${k.title}`} onClick={() => onInclude(k.id, k.included ? false : null)}>
              <Icon name={k.included ? 'close' : 'undo'} size={16} />
            </button>
          </span>
        ))}
      </div>
      {maybe.length > 0 && (
        <Column gap={8}>
          <Text variant="caption" tone="tertiary">{s.focus.maybe}</Text>
          <div className={css.kps}>
            {maybe.map((k) => (
              <button key={k.id} type="button" className={cx(css.kp, k.included ? undefined : css.maybe, !k.included && css.dashed)} aria-pressed={k.included} onClick={() => onInclude(k.id, k.included ? false : true)}>
                {k.included && <Icon name="check" size={16} tone="accent" />}{k.title}
              </button>
            ))}
          </div>
        </Column>
      )}
    </Column>
  );
}

function FormatEditor({ courseId }: { courseId: string }) {
  const format = useExamFormat(courseId);
  const apply = useApply();
  const [draft, setDraft] = useState<ExamFormat | null>(null);
  useEffect(() => { if (format.data) setDraft(format.data); }, [format.data]);
  if (!draft || !format.data) return <Skeleton height={240} radius={20} />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(format.data);
  const setType = (type: QuestionType, patch: Partial<ExamFormat['types'][number]>) => setDraft({ ...draft, types: draft.types.map((t) => (t.type === type ? { ...t, ...patch } : t)) });
  const total = draft.types.reduce((sum, t) => sum + t.count * t.score, 0);
  return (
    <Section id="format" title={s.focus.format} action={<Text variant="caption" tone="tertiary">{s.focus.basis(s.basis[draft.basis])} · 共 {total} 分</Text>}>
      <Group>
        {draft.types.map((t) => (
          <div key={t.type} className={css.formatRow}>
            <Text strong>{s.qtype[t.type]}</Text>
            <Stepper label={`${s.qtype[t.type]}题量`} value={t.count} onChange={(v) => setType(t.type, { count: v })} min={0} max={30} format={(v) => `${v} 道`} />
            <Stepper label={`${s.qtype[t.type]}每题分值`} value={t.score} onChange={(v) => setType(t.type, { score: v })} min={1} max={30} format={(v) => `${v} 分`} />
          </div>
        ))}
        <div className={css.formatRow}>
          <Text strong>{s.focus.duration}</Text>
          <span />
          <Stepper label={s.focus.duration} value={draft.duration_min ?? 120} onChange={(v) => setDraft({ ...draft, duration_min: v })} min={30} max={240} step={10} format={(v) => `${v} 分钟`} />
        </div>
        <div className={css.formatRow}>
          <Text strong>形式</Text>
          <span />
          <Segmented label="开闭卷" value={draft.open_book ? 'open' : 'closed'} onChange={(v) => setDraft({ ...draft, open_book: v === 'open' })} options={[{ value: 'closed', label: s.focus.closedBook }, { value: 'open', label: s.focus.openBook }]} />
        </div>
      </Group>
      {dirty && (
        <Row gap={8} justify="end">
          <Button variant="neutral" onClick={() => setDraft(format.data!)}>{s.action.cancel}</Button>
          <Button variant="primary" onClick={() => void apply(() => api.setExamFormat(courseId, { types: draft.types, duration_min: draft.duration_min, open_book: draft.open_book }))}>{s.action.save}</Button>
        </Row>
      )}
    </Section>
  );
}

export function FocusPage() {
  const { cid = '' } = useParams();
  const bp = useBreakpoint();
  const qc = useQueryClient();
  const apply = useApply();
  const course = useCourse(cid);
  const focus = useFocus(cid);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const highlight = useHighlight('focus');
  usePageContext(course.data ? { route: `/c/${cid}/focus`, course_id: cid, chips: [{ key: 'course_id', label: `${course.data.name} · 老师重点` }] } : null);
  useEffect(() => {
    if (location.hash === '#format') setTimeout(() => document.getElementById('format')?.scrollIntoView({ behavior: 'smooth' }), 300);
  }, []);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.addFragments(cid, text.trim());
      setText('');
      invalidate(qc, ['focus', 'course']);
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  const include = (kpId: string, value: boolean | null) => void apply(() => api.includeKp(cid, kpId, value));

  const data = focus.data;
  const fragments = data?.fragments ?? [];
  const current = fragments.find((f) => f.id === selected) ?? fragments[0];

  const addBox = (
    <Column gap={12}>
      <TextArea label={s.focus.said} hideLabel value={text} onChange={setText} placeholder={s.focus.placeholder} minRows={2} onEnter={() => void add()} />
      <Row justify="end"><Button variant="primary" icon="plus" loading={busy} disabled={!text.trim()} onClick={() => void add()}>{s.action.addFocus}</Button></Row>
    </Column>
  );
  const conflicts = (data?.conflicts ?? []).map((c) => (
    <Notice key={c.id} tone="warn" icon="warning">
      <Row gap={8} wrap>
        <span>{c.text}</span>
        <Chip onClick={() => void apply(() => api.resolveConflict(c.id, 'excluded'))}>{s.level.excluded}</Chip>
        <Chip onClick={() => void apply(() => api.resolveConflict(c.id, 'emphasized'))}>{s.level.emphasized}</Chip>
      </Row>
    </Notice>
  ));

  const fragmentRow = (f: Fragment) => {
    const level = levelOf(f);
    const on = !isCompact(bp) && current?.id === f.id;
    return (
      <div key={f.id}>
        <div className={cx(css.frag, on && css.fragOn)} role="button" tabIndex={0} onClick={() => setSelected(f.id)} onKeyDown={(e) => e.key === 'Enter' && setSelected(f.id)}>
          <span className={cx(css.mark, level === 'excluded' && css.excluded, level === 'mentioned' && css.mentioned)} aria-hidden />
          <Column gap={8} grow>
            <Text variant="bodySm">“{f.text}”</Text>
            <Row gap={8} wrap>
              {!f.found ? <Tag tone="warning">{s.focus.notFound}</Tag> : <>
                {level && <Tag tone={level === 'excluded' ? 'neutral' : level === 'emphasized' ? 'strong' : 'accent'}>{s.level[level]}</Tag>}
                <Text variant="caption" tone="tertiary" as="span">{f.kps.filter((k) => k.included).length} 个知识点</Text>
              </>}
            </Row>
            {isCompact(bp) && selected === f.id && <div style={{ paddingTop: 8 }}><FragmentKps fragment={f} onInclude={include} /></div>}
          </Column>
          <span onClick={(e) => e.stopPropagation()}>
            <Menu items={[{ label: s.action.delete, icon: 'trash', danger: true, onSelect: () => void apply(() => api.deleteFragment(f.id)) }]} />
          </span>
        </div>
      </div>
    );
  };

  const said = (
    <Section title={s.focus.said}>
      {addBox}
      {data?.job && <Notice icon="info">正在对应到知识点……</Notice>}
      {conflicts}
      {focus.isLoading ? <Skeleton height={160} radius={20} /> : fragments.length === 0 ? <EmptyState icon="flag" title={s.focus.emptySaid} /> : <Group highlight={highlight}>{fragments.map(fragmentRow)}</Group>}
    </Section>
  );
  const mapped = current && (
    <Section title={s.focus.mapped}>
      <Group padded>
        <Column gap={12}>
          <Text variant="caption" tone="secondary">“{current.text}”</Text>
          <FragmentKps fragment={current} onInclude={include} />
        </Column>
      </Group>
    </Section>
  );

  if (focus.isError) return <Page back={`/c/${cid}`} title={s.focus.title}><ErrorState error={focus.error} onRetry={() => void focus.refetch()} /></Page>;
  return (
    <Page back={`/c/${cid}`} title={s.focus.title} subtitle={course.data?.name}>
      {isCompact(bp) ? <Column gap={32}>{said}<FormatEditor courseId={cid} /></Column> : (
        <Column gap={32}>
          <Split main={said} side={mapped} ratio="1fr 1fr" stickySide />
          <FormatEditor courseId={cid} />
        </Column>
      )}
    </Page>
  );
}
