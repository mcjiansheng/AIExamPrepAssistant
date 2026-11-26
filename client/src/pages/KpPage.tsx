// 知识点学习页：把一个知识点弄懂，并当场确认懂了（06 第 7 节）。平板和电脑左原页、右讲解与小测。
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { useApply, useKp, usePage, useThreads } from '../api/hooks';
import type { Command, KpState, Ref } from '../api/types';
import { ChatCard } from '../features/assistant/Cards';
import { usePageContext } from '../features/assistant/context';
import { useChat } from '../features/assistant/useChat';
import css from '../features/kp/kp.module.css';
import { KpQuiz } from '../features/kp/KpQuiz';
import { PagePreview } from '../features/materials/PagePreview';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Blocks, RefChip } from '../ui/Blocks';
import { Button, IconButton } from '../ui/Button';
import { Chip, Tag } from '../ui/Chip';
import { ErrorState, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { KnowledgeMap } from '../ui/KnowledgeMap';
import { Menu } from '../ui/Sheet';
import { Page, Section, Split } from '../ui/Page';
import { RichText, Text } from '../ui/Text';
import { Column, Row, Scroll } from '../layout';

const STATE_TONE: Record<KpState, 'neutral' | 'accent' | 'warning' | 'success'> = { new: 'neutral', learned: 'accent', shaky: 'warning', mastered: 'success' };

function SourcePage({ source, courseId }: { source: Ref; courseId: string }) {
  const page = usePage(source.material_id, source.page);
  return <PagePreview page={page.data} quote={source.quote} loading={page.isLoading} to={`/m/${source.material_id}/p/${source.page}?c=${courseId}${source.quote ? `&q=${encodeURIComponent(source.quote)}` : ''}`} />;
}

export function KpPage() {
  const { cid = '', kid = '' } = useParams();
  const [params] = useSearchParams();
  const taskId = params.get('task');
  const navigate = useNavigate();
  const bp = useBreakpoint();
  const kp = useKp(kid, taskId);
  const apply = useApply();
  const threads = useThreads();
  const thread = threads.data?.find((t) => t.kind === 'course' && t.course_id === cid);
  const chat = useChat(thread?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState<string[]>([]);
  const prevState = useRef<KpState | null>(null);
  const d = kp.data;

  useEffect(() => { chat.clearLast(); prevState.current = null; setChanged([]); }, [kid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void api.resume({ kind: 'kp', course_id: cid, kp_id: kid }).catch(() => undefined); }, [cid, kid]);
  useEffect(() => {
    if (!d) return;
    if (prevState.current && prevState.current !== d.state) setChanged([d.id]);
    prevState.current = d.state;
  }, [d]);
  usePageContext(d ? { route: `/c/${cid}/kp/${kid}`, course_id: cid, kp_id: kid, chips: [{ key: 'kp_id', label: `${d.chapter.title.replace(/^第.章\s*/, '')} · ${d.title}` }] } : null);

  if (kp.isError) return <Page back={`/c/${cid}`} title=" "><ErrorState error={kp.error} onRetry={() => void kp.refetch()} /></Page>;
  if (!d) return <Page back={`/c/${cid}`} title=" "><Column gap={16}><Skeleton height={28} width="50%" /><Skeleton height={120} radius={16} /><Skeleton height={200} radius={16} /></Column></Page>;

  const go = (id: string | null) => id && navigate(`/c/${cid}/kp/${id}${taskId ? `?task=${taskId}` : ''}`, { replace: true });
  const understood = async () => {
    setBusy(true);
    try {
      const r = await apply(() => api.understood(kid, taskId));
      if (r.next_kp_id) go(r.next_kp_id);
      else if (r.task?.status === 'done') { useUi.getState().toast('这一组学完了'); navigate('/', { viewTransition: true }); }
      else void kp.refetch();
    } catch { /* 已提示 */ } finally { setBusy(false); }
  };
  const ai = (command: Command, label: string) => {
    if (!thread) return;
    void chat.send(label, { command, context: { route: `/c/${cid}/kp/${kid}`, course_id: cid, kp_id: kid } });
  };
  const result = chat.live ?? chat.last;
  const aiButtons: [Command, string][] = [['simplify', s.kp.simplify], ['example', s.kp.example], ['quiz', s.kp.quizMe], ['compare', s.kp.compare]];

  const header = (
    <div className={css.top}>
      <Row gap={8} wrap>
        <Tag tone={STATE_TONE[d.state]}>{s.kpState[d.state]}</Tag>
        {d.level !== 'none' && <Tag tone={d.level === 'excluded' ? 'neutral' : 'strong'}>{s.level[d.level]}</Tag>}
        {d.task && <Text variant="caption" tone="accent" as="span">{s.kp.taskStep(d.task.index, d.task.total)}</Text>}
      </Row>
      <KnowledgeMap chapters={[d.map]} courseId={cid} current={d.id} changed={changed} bare />
    </div>
  );

  const teacher = d.teacher.length > 0 && (
    <Column gap={8}>
      {d.teacher.map((t) => (
        <div key={t.fragment_id} className={css.quote}><Icon name="flag" size={18} /><Column gap={2}><Text variant="caption" tone="secondary">{s.kp.teacher}</Text><Text variant="bodySm">“{t.text}”</Text></Column></div>
      ))}
    </Column>
  );

  const explanation = (
    <Column gap={16}>
      {d.sections.map((sec, i) => (
        <div key={i} className={css.section}>
          <Blocks blocks={sec.blocks} />
          {sec.refs.length > 0 && <Row gap={8} wrap>{sec.refs.map((r, j) => <RefChip key={j} source={r} courseId={cid} />)}</Row>}
        </div>
      ))}
    </Column>
  );

  const how = (
    <Section title={s.kp.how}>
      <div className={css.how}>
        {d.modes.map((m) => <Tag key={m} tone="accent">{s.mode[m]}</Tag>)}
        {d.types.map((t) => <Tag key={t}>{s.qtype[t]}</Tag>)}
      </div>
    </Section>
  );

  const aiResult = result && (
    <div className={css.ai} aria-live="polite">
      {(result.text || !result.done) && <Text variant="bodySm"><RichText text={result.text} /></Text>}
      {!result.done && result.cards.length === 0 && <Skeleton height={80} radius={16} />}
      {result.cards.map((c) => <ChatCard key={c.id} card={c} h={{ threadId: thread?.id ?? null, ask: (t, command) => command && ai(command, t), resend: () => undefined, leave: () => undefined }} />)}
    </div>
  );

  const aiRow = (
    <Scroll axis="x" label="AI 动作">
      <div style={{ display: 'flex', gap: 8 }}>
        {aiButtons.map(([command, label]) => <Chip key={command} icon={command === 'quiz' ? 'quick' : 'assistant'} onClick={() => ai(command, label)}>{label}</Chip>)}
      </div>
    </Scroll>
  );

  const quiz = d.quiz.length > 0 && (
    <Section title={s.kp.quiz}>
      <KpQuiz questions={d.quiz} courseId={cid} onAnswered={() => void kp.refetch()} />
    </Section>
  );

  const pages = d.pages.length > 0 && (
    <Section title={s.kp.pages}>
      <div className={css.pages}>{d.pages.slice(0, 2).map((p, i) => <SourcePage key={i} source={p} courseId={cid} />)}</div>
    </Section>
  );

  const understoodButton = (
    <Button variant="primary" size="lg" block={isCompact(bp)} icon="check" loading={busy} onClick={() => void understood()}>
      {d.understood_at ? (d.next_id ? s.kp.next : s.action.understood) : s.action.understood}
    </Button>
  );

  const actions = (
    <>
      <IconButton icon="chevronLeft" label={s.kp.prev} disabled={!d.prev_id} onClick={() => go(d.prev_id)} />
      <IconButton icon="chevronRight" label={s.kp.next} disabled={!d.next_id} onClick={() => go(d.next_id)} />
      <Menu items={[
        { label: s.kp.markShaky, icon: 'mistakes', onSelect: () => void apply(() => api.markKp(kid, 'shaky')) },
        { label: s.kp.markMastered, icon: 'checkCircle', onSelect: () => void apply(() => api.markKp(kid, 'mastered')) },
        { label: '问助手', icon: 'assistant', onSelect: () => useUi.getState().sendToAssistant({ text: `讲讲${d.title}`, context: { course_id: cid, kp_id: kid } }) },
      ]} />
    </>
  );

  if (isCompact(bp)) {
    return (
      <Page back={taskId ? '/' : `/c/${cid}`} title={d.title} subtitle={`${d.chapter.title} · ${d.topic.title}`} actions={actions} titleTransition={`kp-${d.id}`} width="reading">
        <Column gap={24}>
          {header}
          {teacher}
          {explanation}
          {aiResult}
          {how}
          {pages}
          {quiz}
        </Column>
        <div className={css.bottom}>
          {aiRow}
          {understoodButton}
        </div>
      </Page>
    );
  }

  return (
    <Page back={taskId ? '/' : `/c/${cid}`} title={d.title} subtitle={`${d.chapter.title} · ${d.topic.title}`} actions={actions} titleTransition={`kp-${d.id}`}>
      <Split
        reverse
        stickySide
        ratio="3fr 2fr"
        side={<Column gap={16}>{pages || <Text tone="tertiary">没有对应的课件页</Text>}</Column>}
        main={(
          <Column gap={24}>
            {header}
            {teacher}
            {explanation}
            {aiRow}
            {aiResult}
            {how}
            {quiz}
            <Row gap={12}>{understoodButton}</Row>
          </Column>
        )}
      />
    </Page>
  );
}
