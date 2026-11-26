// 对话卡片：改动（撤销）、提议（确认）、题目、练习、讲解、地图、日程、任务、资料、用量、连接、插件（03 第 5 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { errorText, invalidate, keys, useCourses } from '../../api/hooks';
import type { Card, Command, ID, Mark, Question, TemplateNode } from '../../api/types';
import { duration, money, relativeDay, tokens } from '../../lib/format';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Blocks, RefChip } from '../../ui/Blocks';
import { Button } from '../../ui/Button';
import { ColorDot, Tag } from '../../ui/Chip';
import { ProgressBar } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { KnowledgeMap } from '../../ui/KnowledgeMap';
import { QuestionBody, SelfGrade, SolutionView, Verdict } from '../../ui/Question';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';
import { useStartSession } from '../practice/useStartSession';
import css from './assistant.module.css';

export interface CardHandlers {
  threadId: ID | null;
  ask: (text: string, command?: Command, kpId?: ID | null) => void;
  resend: () => void;
  leave: () => void;
}

export function ChatCard({ card, h }: { card: Card; h: CardHandlers }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const start = useStartSession();
  const courses = useCourses();
  const [busy, setBusy] = useState(false);
  const refresh =() => h.threadId && qc.invalidateQueries({ queryKey: keys.thread(h.threadId) });
  const go = (to: string) => { h.leave(); navigate(to); };

  switch (card.kind) {
    case 'change': {
      const off = card.state !== 'applied';
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="check" tone="success" size={18} /><span className={css.cardTitle}>{card.title}</span></div>
          <div className={`${css.rows} ${off ? css.muted : ''}`}>
            {card.changes.map((c, i) => (
              <div key={i} className={css.row}><span className={css.label}>{c.label}</span><span className={css.to}>{c.from && <span className={css.from}>{c.from}</span>}{c.to}</span></div>
            ))}
          </div>
          <div className={css.actions}>
            {card.state === 'applied' && card.undo_id && (
              <Button size="sm" variant="neutral" icon="undo" loading={busy} onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.undo(card.undo_id!);
                  invalidate(qc, r.affects);
                  useUi.getState().flash(r.affects);
                  await refresh();
                } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
              }}>{s.action.undo}</Button>
            )}
            {card.state === 'undone' && <Text variant="caption" tone="tertiary">{s.assistant.undone}</Text>}
            {card.state === 'expired' && <Text variant="caption" tone="tertiary">{s.assistant.expired}</Text>}
            {card.href && <Button size="sm" variant="text" onClick={() => go(card.href!)}>{s.action.view}</Button>}
          </div>
        </div>
      );
    }
    case 'proposal':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="help" tone="accent" size={18} /><span className={css.cardTitle}>{card.title}</span></div>
          <div className={css.rows}>
            {card.changes.map((c, i) => (
              <div key={i} className={css.row}><span className={css.label}>{c.label}</span><span className={css.to}>{c.from && <span className={css.from}>{c.from}</span>}{c.to}</span></div>
            ))}
          </div>
          {card.estimate && <Text variant="caption" tone="secondary">约 {tokens(card.estimate.tokens_min)}–{tokens(card.estimate.tokens_max)} token</Text>}
          {card.state === 'pending' ? (
            <div className={css.actions}>
              <Button size="sm" variant="primary" loading={busy} onClick={async () => {
                setBusy(true);
                try { const r = await api.resolveProposal(card.id, true); invalidate(qc, r.affects); useUi.getState().flash(r.affects); await refresh(); }
                catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
              }}>{s.action.confirm}</Button>
              <Button size="sm" variant="neutral" onClick={async () => { await api.resolveProposal(card.id, false).catch(() => undefined); await refresh(); }}>{s.action.cancel}</Button>
            </div>
          ) : <Text variant="caption" tone="tertiary">{card.state === 'accepted' ? s.assistant.accepted : s.assistant.declined}</Text>}
        </div>
      );
    case 'question':
      return <QuestionCard question={card.question} />;
    case 'practice':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="quick" tone="accent" size={18} /><span className={css.cardTitle}>{card.title}</span></div>
          <Text variant="caption" tone="secondary">{card.count} 道 · 约 {duration(card.minutes)}</Text>
          <div className={css.actions}>
            <Button size="sm" variant="primary" icon="play" loading={busy} onClick={async () => {
              setBusy(true);
              try { await start({ kind: card.session_kind, course_id: card.course_id, kp_id: card.kp_id ?? undefined, count: card.count }); h.leave(); } finally { setBusy(false); }
            }}>{s.action.start}</Button>
          </div>
        </div>
      );
    case 'explain':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="learn" tone="accent" size={18} /><span className={css.cardTitle}>{card.title}</span></div>
          <Blocks blocks={card.blocks} />
          {card.refs.length > 0 && <Row gap={8} wrap>{card.refs.slice(0, 3).map((r, i) => <RefChip key={i} source={r} />)}</Row>}
          {card.kp_id && (
            <div className={css.actions}>
              <Button size="sm" variant="neutral" onClick={() => h.ask(s.kp.simplify, 'simplify', card.kp_id)}>{s.kp.simplify}</Button>
              <Button size="sm" variant="neutral" onClick={() => h.ask(s.kp.quizMe, 'quiz', card.kp_id)}>{s.kp.quizMe}</Button>
            </div>
          )}
        </div>
      );
    case 'map':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><span className={css.cardTitle}>{card.chapter.title}</span><Text variant="caption" tone="tertiary">{card.chapter.mastered}/{card.chapter.total}</Text></div>
          <KnowledgeMap chapters={[card.chapter]} courseId={card.course_id} bare />
          <div className={css.actions}><Button size="sm" variant="text" onClick={() => go(`/c/${card.course_id}`)}>打开课程</Button></div>
        </div>
      );
    case 'schedule':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="schedule" tone="accent" size={18} /><span className={css.cardTitle}>{card.title}</span></div>
          {card.days.map((d) => (
            <div key={d.date} className={css.dayRow}>
              <Text variant="caption" tone="secondary" strong>{relativeDay(d.date)}</Text>
              {d.tasks.length === 0 && <Text variant="caption" tone="tertiary">{s.schedule.free}</Text>}
              {d.tasks.slice(0, 4).map((t) => (
                <div key={t.id} className={css.taskLine}><span style={{ width: 4, height: 14, borderRadius: 2, background: `var(--course-${(courses.data?.find((c) => c.id === t.course_id)?.color ?? 0) % 8})` }} /><span style={{ flex: 1 }}>{t.title}</span><Text variant="caption" tone="tertiary" as="span">{t.minutes} 分钟</Text></div>
              ))}
            </div>
          ))}
          <div className={css.actions}><Button size="sm" variant="text" onClick={() => go('/schedule')}>打开日程</Button></div>
        </div>
      );
    case 'task':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="list" tone="accent" size={18} /><span className={css.cardTitle}>{card.title}</span></div>
          {card.steps.map((st, i) => (
            <div key={i} className={css.step}>
              <Icon name={st.status === 'done' ? 'checkCircle' : st.status === 'failed' ? 'wrongCircle' : st.status === 'running' ? 'hourglass' : 'clock'} size={16} tone={st.status === 'done' ? 'success' : 'tertiary'} />
              <span>{st.label}</span>
            </div>
          ))}
          {card.state === 'running' && card.job_id && <div className={css.actions}><Button size="sm" variant="neutral" icon="stop" onClick={() => void api.stopTask(card.job_id!).then(() => { void refresh(); })}>{s.action.stop}</Button></div>}
        </div>
      );
    case 'material':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="file" tone="accent" size={18} /><span className={css.cardTitle}>{card.material.title}</span><Tag>{s.materialKind[card.material.kind]}</Tag></div>
          {card.material.status !== 'ready' && <ProgressBar value={card.material.progress ?? 0} label={card.material.stage ?? ''} />}
          <div className={css.actions}><Button size="sm" variant="text" onClick={() => go(`/c/${card.material.course_id}/materials`)}>{s.action.view}</Button></div>
        </div>
      );
    case 'usage':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="gauge" tone="accent" size={18} /><span className={css.cardTitle}>{card.label}</span></div>
          <Row gap={16}><Text variant="h2">{tokens(card.tokens)}</Text><Text tone="secondary">约 {money(card.cost)}</Text></Row>
          <div className={css.actions}><Button size="sm" variant="text" onClick={() => go('/me/ai/usage')}>{s.me.usage}</Button></div>
        </div>
      );
    case 'connect':
      return (
        <div className={css.card}>
          <div className={css.cardHead}><Icon name="key" tone="accent" size={18} /><span className={css.cardTitle}>{s.assistant.connectFirst}</span></div>
          <Text variant="caption" tone="secondary">{card.reason}</Text>
          <div className={css.actions}><Button size="sm" variant="primary" onClick={async () => { if (await useUi.getState().requestConnect(card.reason)) h.resend(); }}>{s.action.connect}</Button></div>
        </div>
      );
    case 'plugin':
      return <div className={css.card}><Template node={card.template} /></div>;
  }
}

function QuestionCard({ question }: { question: Question }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(question);
  const [draft, setDraft] = useState('');
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try { const r = await api.attempt(q.id, draft || null); setQ(r.question); invalidate(qc, ['map', 'course']); }
    catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  return (
    <div className={css.card}>
      <QuestionBody q={q} draft={draft} onDraft={setDraft} onSubmitEnter={submit} />
      {!q.attempt && <div className={css.actions}><Button size="sm" variant="primary" loading={busy} disabled={q.type === 'single' && !draft} onClick={submit}>{s.action.submit}</Button></div>}
      {q.attempt && (
        <Column gap={12}>
          <Verdict q={q} />
          {q.attempt.state === 'needs_self_grade' && q.solution?.rubric && (
            <>
              <SelfGrade q={q} marks={marks} onChange={setMarks} />
              <div className={css.actions}><Button size="sm" variant="primary" onClick={async () => { const r = await api.grade(q.id, marks); setQ(r.question); }}>{s.action.confirm}</Button></div>
            </>
          )}
          <SolutionView q={q} />
        </Column>
      )}
    </div>
  );
}

function Template({ node }: { node: TemplateNode }) {
  const p = node.props as Record<string, string | number | string[][] | undefined>;
  switch (node.type) {
    case 'title': return <Text variant="h3">{String(p.text ?? '')}</Text>;
    case 'text': return <Text variant="bodySm">{String(p.text ?? '')}</Text>;
    case 'code': case 'formula': return <Blocks blocks={[{ kind: 'code', text: String(p.text ?? ''), lang: null }]} />;
    case 'table': return <Blocks blocks={[{ kind: 'table', header: (p.header as unknown as string[]) ?? [], rows: (p.rows as string[][]) ?? [] }]} />;
    case 'list': return <Blocks blocks={[{ kind: 'list', ordered: false, items: (p.items as unknown as string[]) ?? [] }]} />;
    case 'progress': return <ProgressBar value={Number(p.value ?? 0)} label={String(p.label ?? '')} />;
    case 'image': return <img src={String(p.url ?? '')} alt={String(p.alt ?? '')} style={{ maxWidth: '100%', borderRadius: 12 }} />;
    case 'button': return <Button size="sm" variant="neutral">{String(p.label ?? '')}</Button>;
    case 'columns': return <Row gap={12} align="start">{node.children?.map((c, i) => <Template key={i} node={c} />)}</Row>;
  }
  return null;
}

export { ColorDot };
