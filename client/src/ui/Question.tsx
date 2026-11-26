// 题目视图：题干块、选项或输入区、作答后的对错反馈（M3）和解析。练习页、小测、对话里的题目卡共用。
import type { Mark, Question } from '../api/types';
import { cx } from '../lib/cx';
import { s } from '../strings/zh-CN';
import { Blocks, Notice, RefChip } from './Blocks';
import { Tag } from './Chip';
import css from './content.module.css';
import { Icon } from './Icon';
import { Segmented, TextArea, TextField } from './Inputs';
import { Text } from './Text';
import { Row } from '../layout';

export function QuestionMeta({ q, showKp = true }: { q: Question; showKp?: boolean }) {
  return (
    <div className={css.qmeta}>
      <Tag>{s.qtype[q.type]}</Tag>
      <Text variant="caption" tone="tertiary" as="span">{q.score} 分</Text>
      {showKp && <Text variant="caption" tone="tertiary" as="span">· {q.kp.title}</Text>}
      {q.check === 'checking' && q.status === 'ready' && <Tag tone="accent" icon="hourglass">{s.session.checking}</Tag>}
      {q.check === 'unchecked' && <Tag tone="warning">{s.session.unchecked}</Tag>}
      {q.peeked && <Tag tone="warning">{s.session.peeked}</Tag>}
    </div>
  );
}

export function QuestionBody({ q, draft, onDraft, onSubmitEnter, feedback }: {
  q: Question;
  draft: string;
  onDraft: (v: string) => void;
  onSubmitEnter?: () => void;
  /** 刚提交时的对错，用于动效 */
  feedback?: 'correct' | 'wrong' | null;
}) {
  const answered = !!q.attempt;
  const key = q.solution?.answer;
  return (
    <div className={css.question}>
      <Blocks blocks={q.stem} />
      {q.type === 'single' && q.options && (
        <div className={css.options} role="radiogroup" aria-label="选项">
          {q.options.map((o) => {
            const picked = (answered ? q.attempt?.response : draft) === o.id;
            const right = answered && o.id === key;
            const wrong = answered && picked && o.id !== key;
            return (
              <button
                key={o.id} type="button" role="radio" aria-checked={picked} disabled={answered}
                className={cx(css.option, !answered && picked && css.picked, right && css.right, wrong && css.wrong, right && picked && feedback === 'correct' && css.bounce, wrong && feedback === 'wrong' && css.shake)}
                onClick={() => onDraft(o.id)}
              >
                <span className={css.letter}>{right ? <Icon name="check" size={16} /> : wrong ? <Icon name="close" size={16} /> : o.id}</span>
                <span className={css.optText}>{o.text}</span>
              </button>
            );
          })}
        </div>
      )}
      {(q.type === 'fill' || q.type === 'calc') && !answered && (
        <TextField label={s.session.yourAnswer} hideLabel value={draft} onChange={onDraft} placeholder={q.type === 'fill' ? s.session.placeholderFill : s.session.placeholderCalc} onEnter={onSubmitEnter} autoComplete="off" />
      )}
      {(q.type === 'short' || q.type === 'proof' || q.type === 'design') && !answered && (
        <TextArea label={s.session.yourAnswer} hideLabel value={draft} onChange={onDraft} placeholder={s.session.placeholderText} minRows={4} />
      )}
      {answered && q.type !== 'single' && q.attempt?.response && (
        <div><Text variant="caption" tone="tertiary">{s.session.yourAnswer}</Text><Text>{q.attempt.response}</Text></div>
      )}
    </div>
  );
}

export function Verdict({ q }: { q: Question }) {
  const a = q.attempt;
  if (!a || a.state !== 'graded') return null;
  const full = (a.score ?? 0) >= q.score;
  const none = (a.score ?? 0) === 0;
  const tone = full ? 'success' : none ? 'danger' : 'warning';
  return (
    <div className={css.verdict} role="status">
      <Icon name={full ? 'checkCircle' : none ? 'wrongCircle' : 'warning'} tone={tone} />
      <Text tone={tone} strong as="span">{full ? s.session.correct : none ? s.session.wrong : s.session.partial}</Text>
      <Text variant="bodySm" tone="secondary" as="span">{a.score ?? 0}/{q.score} 分</Text>
    </div>
  );
}

export function SolutionView({ q, courseId }: { q: Question; courseId?: string }) {
  if (!q.solution) return null;
  return (
    <div className={css.solution}>
      {q.check === 'flagged' && <Notice tone="danger" icon="flag">{q.check_note ?? s.session.flagged}</Notice>}
      <div>
        <Text variant="caption" tone="tertiary">{s.session.answer}</Text>
        <Text strong>{q.type === 'single' ? `${q.solution.answer}. ${q.options?.find((o) => o.id === q.solution?.answer)?.text ?? ''}` : q.solution.answer}</Text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Text variant="caption" tone="tertiary">{s.session.solution}</Text>
        {q.solution.steps.map((step) => (
          <div key={step.n} className={css.step}>
            {q.solution!.steps.length > 1 && <span className={css.stepNo}>{step.n}</span>}
            <Blocks blocks={step.blocks} />
          </div>
        ))}
      </div>
      {q.refs.length > 0 && <Row gap={8} wrap>{q.refs.map((r, i) => <RefChip key={i} source={r} courseId={courseId} />)}</Row>}
    </div>
  );
}

export function SelfGrade({ q, marks, onChange }: { q: Question; marks: Record<string, Mark>; onChange: (m: Record<string, Mark>) => void }) {
  const rubric = q.solution?.rubric ?? [];
  return (
    <div className={css.rubric} aria-label={s.session.selfGrade}>
      <Text variant="bodySm" tone="secondary" strong>{s.session.selfGrade}</Text>
      {rubric.map((r) => (
        <div key={r.id} className={css.rubricRow}>
          <Text variant="bodySm" as="span">{r.point}<Text variant="caption" tone="tertiary" as="span">（{r.score} 分）</Text></Text>
          <Segmented<Mark>
            label={r.point}
            value={marks[r.id] ?? 'none'}
            onChange={(v) => onChange({ ...marks, [r.id]: v })}
            options={(['full', 'partial', 'none'] as Mark[]).map((m) => ({ value: m, label: s.mark[m] }))}
          />
        </div>
      ))}
    </div>
  );
}

export function HintCard({ level, text }: { level: 1 | 2 | 3; text: string }) {
  const title = level === 1 ? s.session.hint1 : level === 2 ? s.session.hint2 : s.session.hint3;
  return (
    <div className={cx(css.hint, level === 3 && css.full)}>
      <Icon name="hint" tone={level === 3 ? 'accent' : 'warning'} />
      <div><Text variant="caption" tone="secondary" strong>{title}</Text><Text variant="bodySm">{text}</Text></div>
    </div>
  );
}

export const contentCss = css;
