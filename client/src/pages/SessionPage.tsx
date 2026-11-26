// 作答（全屏）：手机和快练、复习是单题模式；平板和电脑上的模拟卷是整卷模式（06 第 12 节）。
// 先出后核：第一道出好就能做，其余题位逐个亮起（M5）；核对中的题照常作答。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../api/endpoints';
import { errorText, invalidate, keys, useSettings } from '../api/hooks';
import type { Mark, MasteryChange, Question, ReportKind, Session } from '../api/types';
import { usePageContext } from '../features/assistant/context';
import { HintPanel } from '../features/session/HintPanel';
import css from '../features/session/session.module.css';
import { cx } from '../lib/cx';
import { clock } from '../lib/format';
import { isCompact, useBreakpoint } from '../state/breakpoint';
import { useUi } from '../state/ui';
import { s } from '../strings/zh-CN';
import { Button, IconButton } from '../ui/Button';
import { ConfirmDialog, Menu, Sheet } from '../ui/Sheet';
import { ErrorState, Skeleton } from '../ui/Feedback';
import { Icon } from '../ui/Icon';
import { TextArea } from '../ui/Inputs';
import { Cell } from '../ui/KnowledgeMap';
import { Notice } from '../ui/Blocks';
import { QuestionBody, QuestionMeta, SelfGrade, SolutionView, Verdict } from '../ui/Question';
import { ListItem } from '../ui/Surfaces';
import { Text } from '../ui/Text';

export function SessionPage() {
  const { sid = '' } = useParams();
  const navigate = useNavigate();
  const bp = useBreakpoint();
  const qc = useQueryClient();
  const settings = useSettings();
  const session = useQuery({
    queryKey: keys.session(sid),
    queryFn: () => api.session(sid),
    refetchInterval: (query) => (query.state.data?.questions.some((q) => q.status === 'pending' || q.check === 'checking') ? 2000 : false),
  });
  const data = session.data;
  const questions = useMemo(() => (data?.questions ?? []).filter((q) => q.status !== 'hidden'), [data]);
  const [index, setIndex] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [marks, setMarks] = useState<Record<string, Record<string, Mark>>>({});
  const [feedback, setFeedback] = useState<{ id: string; kind: 'correct' | 'wrong' } | null>(null);
  const [changes, setChanges] = useState<Record<string, MasteryChange[]>>({});
  const [hintOpen, setHintOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const [timerHidden, setTimerHidden] = useState(false);
  const [paperPref, setPaperPref] = useState<boolean | null>(null);
  const [scratch, setScratch] = useState('');
  const [nudge, setNudge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const nudged = useRef(new Set<string>());
  const versions = useRef(new Map<string, number>());
  const wrongStreak = useRef(new Map<string, number>());

  const paper = !isCompact(bp) && (paperPref ?? data?.kind === 'mock');
  const i = Math.min(index ?? 0, Math.max(0, questions.length - 1));
  const q: Question | undefined = questions[i];
  usePageContext(data && q ? { route: `/session/${sid}`, course_id: data.course_id ?? undefined, session_id: sid, question_id: q.id, chips: [{ key: 'question_id', label: `第 ${i + 1} 题` }] } : null);

  // 初始位置：上次停的地方，或第一道没做的题
  useEffect(() => {
    if (!data || index !== null) return;
    const firstOpen = questions.findIndex((x) => !x.attempt);
    setIndex(data.position > 0 ? Math.min(data.position, questions.length - 1) : Math.max(0, firstOpen));
  }, [data, index, questions]);
  useEffect(() => { if (data?.status === 'finished') navigate(`/session/${sid}/result`, { replace: true }); }, [data?.status, sid, navigate]);
  // 上报位置（任何设备都能“继续”）
  useEffect(() => {
    if (index === null || !data) return;
    const t = setTimeout(() => {
      void api.setPosition(sid, index).catch(() => undefined);
      if (data.course_id) void api.resume({ kind: 'session', course_id: data.course_id, session_id: sid, position: index }).catch(() => undefined);
    }, 600);
    return () => clearTimeout(t);
  }, [index, sid, data]);
  // 核对后换了题：提示一次
  useEffect(() => {
    for (const x of questions) {
      const before = versions.current.get(x.id);
      if (before !== undefined && x.version > before && x.replaced && !x.attempt) useUi.getState().toast(s.session.replaced);
      versions.current.set(x.id, x.version);
    }
  }, [questions]);
  // 卡住时主动提示：同一题停留 3 分钟，或同一知识点连续答错 2 次（每题一次，可在设置里关）
  useEffect(() => {
    if (!q || q.attempt || q.status !== 'ready' || settings.data?.proactive_hints === false || nudged.current.has(q.id)) return;
    if ((wrongStreak.current.get(q.kp.id) ?? 0) >= 2) { nudged.current.add(q.id); setNudge(q.id); return; }
    const t = setTimeout(() => { nudged.current.add(q.id); setNudge(q.id); }, 180_000);
    return () => clearTimeout(t);
  }, [q, settings.data?.proactive_hints]);
  // 计时（模拟卷）
  useEffect(() => {
    if (!data?.time_limit_min) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [data?.time_limit_min]);
  const remaining = data?.time_limit_min && data.started_at ? data.time_limit_min * 60 - (now - Date.parse(data.started_at)) / 1000 : null;
  useEffect(() => { if (remaining !== null && remaining <= 0 && !timeUp && data?.status !== 'finished') setTimeUp(true); }, [remaining, timeUp, data?.status]);

  const patch = (next: Question) => qc.setQueryData<Session>(keys.session(sid), (old) => old && { ...old, questions: old.questions.map((x) => (x.id === next.id ? next : x)) });
  const submit = async () => {
    if (!q || q.attempt || q.status !== 'ready' || busy) return;
    const draft = drafts[q.id] ?? '';
    if (q.type === 'single' && !draft) return;
    setBusy(true);
    try {
      const r = await api.attempt(q.id, draft || null);
      patch(r.question);
      setChanges((c) => ({ ...c, [q.id]: r.mastery }));
      if (r.question.attempt?.state === 'graded') {
        const ok = !!r.question.attempt.correct;
        setFeedback({ id: q.id, kind: ok ? 'correct' : 'wrong' });
        wrongStreak.current.set(q.kp.id, ok ? 0 : (wrongStreak.current.get(q.kp.id) ?? 0) + 1);
        if (navigator.vibrate && ok) navigator.vibrate(10);
      }
      if (r.question.solution?.rubric && r.question.attempt?.marks) setMarks((m) => ({ ...m, [q.id]: r.question.attempt!.marks! }));
      if (r.mastery.length) invalidate(qc, ['map', 'course']);
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  const grade = async () => {
    if (!q) return;
    setBusy(true);
    try {
      const r = await api.grade(q.id, marks[q.id] ?? {});
      patch(r.question);
      setChanges((c) => ({ ...c, [q.id]: r.mastery }));
      const score = r.question.attempt?.score ?? 0;
      wrongStreak.current.set(q.kp.id, score >= q.score ? 0 : (wrongStreak.current.get(q.kp.id) ?? 0) + 1);
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  const unanswered = questions.filter((x) => x.status === 'ready' && !x.attempt).length;
  const finish = async () => {
    setFinishOpen(false);
    setTimeUp(false);
    setBusy(true);
    try {
      const result = await api.finish(sid);
      qc.setQueryData(keys.result(sid), result);
      invalidate(qc, ['today', 'practice', 'map', 'course', 'courses', 'mistakes', 'insight']);
      navigate(`/session/${sid}/result`, { replace: true, viewTransition: true });
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  const next = () => {
    if (i < questions.length - 1) { setIndex(i + 1); setFeedback(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (unanswered > 0) setFinishOpen(true);
    else void finish();
  };
  const report = async (kind: ReportKind) => {
    if (!q) return;
    setReportOpen(false);
    const r = await api.report(q.id, kind, null).catch(() => null);
    if (r) { patch(r.question); useUi.getState().toast(s.session.reportDone); }
  };
  // 键盘：A–D 选项，Enter 提交 / 下一题，整卷模式左右切题
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea') || !q) return;
      const letter = e.key.toUpperCase();
      if (!q.attempt && q.options?.some((o) => o.id === letter)) setDrafts((d) => ({ ...d, [q.id]: letter }));
      else if (e.key === 'Enter') { if (!q.attempt) void submit(); else if (q.attempt.state === 'graded') next(); }
      else if (paper && e.key === 'ArrowRight' && i < questions.length - 1) setIndex(i + 1);
      else if (paper && e.key === 'ArrowLeft' && i > 0) setIndex(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (session.isError) return <div className={css.screen}><ErrorState error={session.error} onRetry={() => void session.refetch()} /></div>;
  const answered = questions.filter((x) => x.attempt).length;
  const exit = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate(data?.course_id ? `/c/${data.course_id}` : '/'));

  const top = (
    <div className={css.top}>
      <div className={css.bar}>
        <IconButton icon="close" label={s.session.exit} onClick={exit} />
        <div className={css.title}>
          <Text variant="h3" nowrap>{data?.title ?? ' '}</Text>
          <Text variant="caption" tone="secondary">{questions.length ? `${i + 1}/${questions.length}` : s.session.preparing}{data?.status === 'preparing' ? ` · ${s.session.preparing}` : ''}</Text>
        </div>
        {remaining !== null && !timerHidden && (
          <button type="button" className={cx(css.timer, remaining < 300 && css.timerLow)} onClick={() => setTimerHidden(true)} aria-label={`剩余时间 ${clock(remaining)}，点一下隐藏`}><Icon name="timer" size={16} />{clock(remaining)}</button>
        )}
        <Menu items={[
          ...(q?.status === 'ready' && !q.attempt ? [{ label: s.action.report, icon: 'flag' as const, onSelect: () => setReportOpen(true) }] : []),
          ...(!isCompact(bp) ? [{ label: paper ? '单题模式' : '整卷模式', icon: 'grid' as const, onSelect: () => setPaperPref(!paper) }] : []),
          ...(remaining !== null && timerHidden ? [{ label: '显示计时', icon: 'timer' as const, onSelect: () => setTimerHidden(false) }] : []),
          { label: s.action.finish, icon: 'check' as const, onSelect: () => (unanswered ? setFinishOpen(true) : void finish()) },
        ]} />
      </div>
      <div className={css.progress}><div className={css.progressFill} style={{ width: `${questions.length ? (answered / questions.length) * 100 : 0}%` }} /></div>
    </div>
  );

  const slot = !q ? <Skeleton height={240} radius={20} /> : q.status === 'pending' ? (
    <div className={css.card} aria-busy="true">
      <Text tone="secondary">{data?.job?.stage ?? s.session.preparing}</Text>
      <Skeleton height={20} width="70%" /><Skeleton height={16} /><Skeleton height={52} radius={14} /><Skeleton height={52} radius={14} />
    </div>
  ) : q.status === 'failed' ? (
    <div className={css.card}>
      <Notice tone="warn" icon="warning">{s.session.failed}</Notice>
      {data?.job?.error?.retryable && <Button variant="secondary" icon="retry" onClick={() => void api.retryJob(data.job!.id).then(() => session.refetch())}>继续出题</Button>}
    </div>
  ) : (
    <div className={css.card} key={`${q.id}-${q.version}`}>
      <QuestionMeta q={q} />
      <QuestionBody q={q} draft={drafts[q.id] ?? ''} onDraft={(v) => setDrafts((d) => ({ ...d, [q.id]: v }))} onSubmitEnter={() => void submit()} feedback={feedback?.id === q.id ? feedback.kind : null} />
      {q.attempt && <Verdict q={q} />}
      {(changes[q.id] ?? []).map((c) => (
        <div key={c.kp_id} className={css.mastery} role="status">
          <Cell state={c.from} /><Icon name="forward" size={16} tone="tertiary" /><Cell state={c.to} />
          <Text variant="bodySm" as="span">{c.title}：{s.kpState[c.from]} → {s.kpState[c.to]}</Text>
        </div>
      ))}
      {q.attempt?.state === 'needs_self_grade' && q.solution?.rubric && (
        <SelfGrade q={q} marks={marks[q.id] ?? {}} onChange={(m) => setMarks((all) => ({ ...all, [q.id]: m }))} />
      )}
      {(q.attempt || q.peeked) && <SolutionView q={q} courseId={data?.course_id ?? undefined} />}
      {paper && q.hints.length > 0 && !q.attempt && <HintPanel q={q} onQuestion={patch} />}
    </div>
  );

  const primary = !q || q.status !== 'ready' ? (
    <Button variant="primary" size="lg" disabled={!q || q.status === 'pending'} onClick={next}>{s.action.next}</Button>
  ) : !q.attempt ? (
    <Button variant="primary" size="lg" loading={busy} disabled={q.type === 'single' && !drafts[q.id]} onClick={() => void submit()}>{s.action.submit}</Button>
  ) : q.attempt.state === 'needs_self_grade' && q.solution?.rubric ? (
    <Button variant="primary" size="lg" loading={busy} onClick={() => void grade()}>{s.action.confirm}</Button>
  ) : (
    <Button variant="primary" size="lg" loading={busy} onClick={next}>{i < questions.length - 1 ? s.action.next : data?.kind === 'mock' ? s.action.handIn : s.action.finish}</Button>
  );
  const foot = (
    <div className={css.foot}>
      <div className={css.footInner}>
        <span className={css.help}>
          {nudge === q?.id && !q?.attempt && <span className={css.nudge}>{s.session.stuck}</span>}
          <Button variant="neutral" size="lg" icon="hint" disabled={!q || q.status !== 'ready' || !!q.attempt} onClick={() => { setNudge(null); setHintOpen(true); }}>{s.action.help}</Button>
        </span>
        {primary}
      </div>
    </div>
  );

  const grid = (
    <nav className={css.grid} aria-label={s.session.grid}>
      {questions.map((x, n) => (
        <button key={x.id} type="button" onClick={() => setIndex(n)} aria-current={n === i ? 'step' : undefined} aria-label={`第 ${n + 1} 题${x.attempt ? '，已答' : ''}`}
          className={cx(css.cell, x.attempt && css.cellAnswered, n === i && css.cellCurrent, x.status === 'pending' && css.cellPending, x.status === 'failed' && css.cellFailed)}>
          {n + 1}{x.status === 'ready' && x.check === 'checking' && <span className={css.cellDot} aria-hidden />}
        </button>
      ))}
    </nav>
  );

  return (
    <div className={css.screen}>
      {top}
      {paper ? (
        <div className={css.paper}>
          {grid}
          <div className={css.body}>{slot}</div>
          <div className={css.scratch}><TextArea label={s.session.scratch} value={scratch} onChange={setScratch} minRows={10} placeholder="草稿区，只在这台设备上" /></div>
        </div>
      ) : <div className={css.body}>{slot}</div>}
      {foot}
      <Sheet open={hintOpen && !!q} onClose={() => setHintOpen(false)} title={s.action.help}>
        {q && <HintPanel q={q} onQuestion={patch} />}
      </Sheet>
      <Sheet open={reportOpen} onClose={() => setReportOpen(false)} title={s.session.reportTitle}>
        <div>{(Object.keys(s.report) as ReportKind[]).map((k) => <ListItem key={k} title={s.report[k]} onClick={() => void report(k)} />)}</div>
      </Sheet>
      <ConfirmDialog open={finishOpen} title={s.session.unanswered(unanswered)} body="没做的题不计分。" confirm={data?.kind === 'mock' ? s.action.handIn : s.action.finish} onCancel={() => setFinishOpen(false)} onConfirm={() => void finish()} />
      <ConfirmDialog open={timeUp} title={s.session.timeUp} body={`已做 ${answered} 道，还有 ${unanswered} 道没做。`} confirm={s.action.handIn} cancel={s.session.keepGoing} onCancel={() => setTimeUp(false)} onConfirm={() => void finish()} />
    </div>
  );
}
