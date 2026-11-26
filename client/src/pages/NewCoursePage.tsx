// 新建课程引导：一屏一问，每步立即保存，任何一步都能“稍后再说”；整理在后台进行（09 第 4 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { errorText, invalidate, useExamFormat } from '../api/hooks';
import type { Course, ExamFormat } from '../api/types';
import css from '../features/course/wizard.module.css';
import { cx } from '../lib/cx';
import { duration } from '../lib/format';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { useSession } from '../state/session';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Button, IconButton } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { Stepper, TextArea, TextField } from '../ui/Inputs';
import { MapSkeleton } from '../ui/KnowledgeMap';
import { Group } from '../ui/Surfaces';
import { Text } from '../ui/Text';
import { Column, Row } from '../layout';

type Step = 1 | 2 | 3 | 4 | 5 | 6;
const ACCEPT = '.pdf,.ppt,.pptx,.doc,.docx,.txt,.md,image/*';

function FormatStep({ courseId, onDraft }: { courseId: string; onDraft: (f: ExamFormat) => void }) {
  const format = useExamFormat(courseId);
  const [draft, setDraft] = useState<ExamFormat | null>(null);
  useEffect(() => { if (format.data && !draft) setDraft(format.data); }, [format.data, draft]);
  useEffect(() => { if (draft) onDraft(draft); }, [draft, onDraft]);
  if (!draft) return <Skeleton height={240} radius={20} />;
  return (
    <Group>
      {draft.types.map((t) => (
        <div key={t.type} className={css.row}>
          <Text strong>{s.qtype[t.type]}</Text>
          <Text variant="caption" tone="tertiary">每题 {t.score} 分</Text>
          <Stepper label={`${s.qtype[t.type]}题量`} value={t.count} min={0} max={30} format={(v) => `${v} 道`}
            onChange={(v) => setDraft({ ...draft, types: draft.types.map((x) => (x.type === t.type ? { ...x, count: v } : x)) })} />
        </div>
      ))}
    </Group>
  );
}

export function NewCoursePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const bp = useBreakpoint();
  const [step, setStep] = useState<Step>(1);
  const [course, setCourse] = useState<Course | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [focus, setFocus] = useState('');
  const [format, setFormat] = useState<ExamFormat | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const photo = useRef<HTMLInputElement>(null);

  const go = (n: Step) => { setStep(n); window.scrollTo({ top: 0 }); };
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  const create = () => guard(async () => {
    const c = await api.createCourse({ name: name.trim(), exam_date: date || null });
    setCourse(c);
    invalidate(qc, ['courses', 'threads']);
    const user = useSession.getState().user;
    if (user && user.onboarding.course !== 'done') {
      const next = await api.updateMe({ onboarding: { ...user.onboarding, course: 'done' } });
      useSession.getState().setUser(next);
      qc.setQueryData(['me'], next);
    }
    go(2);
  });
  const upload = (list: File[], source: 'file' | 'photo' = 'file') => course && list.length && guard(async () => {
    await api.upload(course.id, list, source);
    setFiles((f) => [...f, ...list.map((x) => x.name)]);
    invalidate(qc, ['courses', 'materials']);
  });
  const next = () => {
    if (step === 1) return void create();
    if (!course) return;
    if (step === 3 && focus.trim()) return void guard(async () => { await api.addFragments(course.id, focus.trim()); go(4); });
    if (step === 4 && format) return void guard(async () => { await api.setExamFormat(course.id, { types: format.types, duration_min: format.duration_min, open_book: format.open_book }); go(5); });
    if (step === 5) return void guard(async () => { if (cap !== null) await api.updateCourse(course.id, { daily_cap_min: cap }); invalidate(qc, ['today', 'schedule']); go(6); });
    if (step === 6) { navigate(`/c/${course.id}`, { replace: true }); return; }
    go((step + 1) as Step);
  };
  const close = () => {
    if (course) navigate(`/c/${course.id}`, { replace: true });
    else if (params.get('first')) navigate('/', { replace: true });
    else navigate(-1);
  };
  const primaryLabel = step === 6 ? s.wizard.enter : '下一步';

  return (
    <div className={css.screen}>
      <div className={css.top}>
        <IconButton icon="close" label={s.action.close} onClick={close} />
        <div className={css.dots} aria-label={`第 ${step} 步，共 6 步`}>
          {[1, 2, 3, 4, 5, 6].map((n) => <span key={n} className={cx(css.dot, n <= step && css.on, n === step && css.current)} />)}
        </div>
        <span style={{ width: 40 }} />
      </div>
      <div className={css.body} key={step}>
        {step === 1 && (
          <>
            <Text variant="h1" as="h1">{s.wizard.title}</Text>
            <TextField label={s.wizard.name} value={name} onChange={setName} placeholder={s.wizard.namePlaceholder} autoFocus onEnter={() => name.trim() && void create()} />
            <Column gap={8}>
              <TextField label={s.wizard.date} value={date} onChange={setDate} type="date" />
              <Row gap={8}><Chip selected={!date} onClick={() => setDate('')}>{s.wizard.unknown}</Chip></Row>
            </Column>
          </>
        )}
        {step === 2 && (
          <>
            <Column gap={8}><Text variant="h1" as="h1">{s.wizard.materials}</Text><Text tone="secondary">{s.wizard.materialsNote}</Text></Column>
            <div
              className={cx(css.drop, over && css.dropOver)}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]); }}
            >
              <Icon name="upload" size={28} tone="accent" />
              {!isCompact(bp) && <Text variant="bodySm" tone="secondary">拖到这里，或</Text>}
              <Row gap={8} wrap justify="center">
                <Button variant="secondary" icon="file" loading={busy} onClick={() => input.current?.click()}>选文件</Button>
                {isCompact(bp) && <Button variant="secondary" icon="camera" onClick={() => photo.current?.click()}>{s.materials.photo}</Button>}
              </Row>
            </div>
            {files.length > 0 && (
              <Column gap={8}>
                {files.map((f, i) => <div key={`${f}-${i}`} className={css.file}><Icon name="checkCircle" tone="success" size={18} />{f}</div>)}
                <Text variant="caption" tone="tertiary">已开始整理，不用等，继续下一步</Text>
              </Column>
            )}
            <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} />
            <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void upload([...(e.target.files ?? [])], 'photo'); e.target.value = ''; }} />
          </>
        )}
        {step === 3 && (
          <>
            <Column gap={8}><Text variant="h1" as="h1">{s.wizard.focus}</Text><Text tone="secondary">老师说过哪些考、哪些不考、题型是什么？{s.wizard.focusNote}</Text></Column>
            <TextArea label={s.wizard.focus} hideLabel value={focus} onChange={setFocus} placeholder="例如：银行家算法一定会考大题，第五章不考。" minRows={5} autoFocus />
          </>
        )}
        {step === 4 && course && (
          <>
            <Column gap={8}><Text variant="h1" as="h1">{s.wizard.format}</Text><Text tone="secondary">{s.wizard.formatNote}</Text></Column>
            <FormatStep courseId={course.id} onDraft={setFormat} />
          </>
        )}
        {step === 5 && (
          <>
            <Text variant="h1" as="h1">{s.wizard.time}</Text>
            <Row gap={8} wrap>
              <Chip selected={cap === null} onClick={() => setCap(null)}>{s.course.auto}</Chip>
              {[30, 45, 60, 90, 120].map((m) => <Chip key={m} selected={cap === m} onClick={() => setCap(m)}>{duration(m)}</Chip>)}
            </Row>
          </>
        )}
        {step === 6 && (
          <Column gap={24} align="center">
            <Icon name="checkCircle" tone="success" size={32} />
            <Text variant="h1" as="h1" center>{s.wizard.done}</Text>
            <Group padded><MapSkeleton count={32} /></Group>
          </Column>
        )}
      </div>
      <div className={css.foot}>
        <div className={css.footInner}>
          <Button variant="primary" size="lg" loading={busy} disabled={step === 1 && !name.trim()} onClick={next}>{primaryLabel}</Button>
          {step > 1 && step < 6 && <Button variant="text" onClick={() => go((step + 1) as Step)}>{s.action.later}</Button>}
        </div>
      </div>
    </div>
  );
}
