// 提示阶梯：方向 → 关键一步 → 完整解析；第 3 级前提示“会记为看过答案”（03 第 4 节、09 第 7.4 节）。
import { useEffect, useState } from 'react';
import { api } from '../../api/endpoints';
import { errorText } from '../../api/hooks';
import type { Question } from '../../api/types';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { Notice, RefChip } from '../../ui/Blocks';
import { Button } from '../../ui/Button';
import { Skeleton } from '../../ui/Feedback';
import { HintCard } from '../../ui/Question';
import { Column, Row } from '../../layout';
import css from './session.module.css';

export function HintPanel({ q, onQuestion }: { q: Question; onQuestion: (q: Question) => void }) {
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState(false);
  const next = (q.hints.at(-1)?.level ?? 0) + 1;
  const ask = async (level: 1 | 2 | 3) => {
    setBusy(true);
    try { const r = await api.hint(q.id, level); onQuestion(r.question); setWarn(false); }
    catch (e) { useUi.getState().toast(errorText(e), 'danger'); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (q.hints.length === 0 && !q.attempt) void ask(1);
    // 只在打开时自动给第 1 级
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id]);
  return (
    <Column gap={16}>
      <div className={css.hints}>
        {q.hints.map((h) => (
          <Column key={h.level} gap={8}>
            <HintCard level={h.level} text={h.text} />
            {h.refs.length > 0 && <Row gap={8} wrap>{h.refs.map((r, i) => <RefChip key={i} source={r} />)}</Row>}
          </Column>
        ))}
        {busy && <Skeleton height={64} radius={16} />}
      </div>
      {warn && <Notice tone="warn" icon="warning">{s.session.peekWarn}</Notice>}
      {!q.attempt && next <= 3 && (
        <Row gap={8} wrap>
          {next === 2 && <Button variant="secondary" icon="hint" loading={busy} onClick={() => void ask(2)}>{s.session.moreHint}</Button>}
          {next >= 2 && (warn
            ? <Button variant="primary" loading={busy} onClick={() => void ask(3)}>{s.session.fullSolution}</Button>
            : <Button variant="neutral" onClick={() => setWarn(true)}>{s.session.fullSolution}</Button>)}
        </Row>
      )}
    </Column>
  );
}
