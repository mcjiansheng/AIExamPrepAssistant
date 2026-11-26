// 知识点页的小测：作答即判（单选、填空），主观题对照评分点自评；答对时页头地图格子变色（M3）。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { errorText, invalidate } from '../../api/hooks';
import type { Mark, Question } from '../../api/types';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Button } from '../../ui/Button';
import { QuestionBody, QuestionMeta, SelfGrade, SolutionView, Verdict } from '../../ui/Question';
import css from './kp.module.css';

export function KpQuiz({ questions, courseId, onAnswered }: { questions: Question[]; courseId: string; onAnswered: () => void }) {
  return (
    <>
      {questions.map((q) => <QuizItem key={q.id} initial={q} courseId={courseId} onAnswered={onAnswered} />)}
    </>
  );
}

function QuizItem({ initial, courseId, onAnswered }: { initial: Question; courseId: string; onAnswered: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(initial);
  const [draft, setDraft] = useState('');
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [feedback, setFeedback] = useState<'correct' | 'wrong' | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (q.type === 'single' && !draft) return;
    setBusy(true);
    try {
      const r = await api.attempt(q.id, draft || null);
      setQ(r.question);
      if (r.question.attempt?.state === 'graded') setFeedback(r.question.attempt.correct ? 'correct' : 'wrong');
      if (r.mastery.length) { invalidate(qc, ['map', 'kp', 'course']); onAnswered(); }
    } catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  const grade = async () => {
    const r = await api.grade(q.id, marks);
    setQ(r.question);
    if (r.mastery.length) { invalidate(qc, ['map', 'kp', 'course']); onAnswered(); }
  };
  const selfGrading = q.attempt?.state === 'needs_self_grade' && q.solution?.rubric;
  return (
    <div className={css.quizItem}>
      <QuestionMeta q={q} showKp={false} />
      <QuestionBody q={q} draft={draft} onDraft={setDraft} onSubmitEnter={submit} feedback={feedback} />
      {!q.attempt && (
        <div className={css.actions}>
          <Button variant="secondary" loading={busy} disabled={q.type === 'single' && !draft} onClick={() => void submit()}>{s.action.submit}</Button>
        </div>
      )}
      {q.attempt && <Verdict q={q} />}
      {selfGrading && (
        <>
          <SelfGrade q={q} marks={marks} onChange={setMarks} />
          <div className={css.actions}><Button variant="secondary" onClick={() => void grade()}>{s.action.confirm}</Button></div>
        </>
      )}
      {q.attempt && <SolutionView q={q} courseId={courseId} />}
    </div>
  );
}
