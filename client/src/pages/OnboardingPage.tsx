// 首次引导：连接 AI → 建第一门课，都能跳过；跳过全部进今天页，示例课程已在列表里（06 第 2 节）。
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/endpoints';
import type { User } from '../api/types';
import { ConnectFlow } from '../features/ai/ConnectFlow';
import css from '../features/course/wizard.module.css';
import { cx } from '../lib/cx';
import { useSession } from '../state/session';
import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { Text } from '../ui/Text';
import { Column } from '../layout';

export function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setUser = useSession((st) => st.setUser);
  const [step, setStep] = useState<1 | 2>(1);
  const mark = async (onboarding: Partial<User['onboarding']>) => {
    const user = await api.updateMe({ onboarding: { ...useSession.getState().user!.onboarding, ...onboarding } });
    setUser(user);
    // 立即写进缓存：AuthGuard 按 /me 判断是否还在引导中，不能等重新请求
    qc.setQueryData(['me'], user);
  };
  const skipAll = async () => { await mark({ ai: useSession.getState().user?.onboarding.ai ?? 'skipped', course: 'skipped' }); navigate('/', { replace: true }); };
  return (
    <div className={css.screen}>
      <div className={css.top}>
        <span style={{ width: 80 }} />
        <div className={css.dots} aria-label={`第 ${step} 步，共 2 步`}>
          {[1, 2].map((n) => <span key={n} className={cx(css.dot, n <= step && css.on, n === step && css.current)} />)}
        </div>
        <Button variant="text" size="sm" onClick={() => void skipAll()}>{s.onboarding.skipAll}</Button>
      </div>
      <div className={css.body} key={step}>
        {step === 1 ? (
          <Column gap={24}>
            <Column gap={8}>
              <Text variant="h1" as="h1">{s.onboarding.connect}</Text>
              <Text tone="secondary">满格用你自己的模型整理资料、出题和讲解。</Text>
            </Column>
            <ConnectFlow onDone={() => { void qc.invalidateQueries(); setStep(2); }} />
            <Button variant="text" onClick={() => { void mark({ ai: 'skipped' }).then(() => setStep(2)); }}>{s.onboarding.skip}</Button>
          </Column>
        ) : (
          <Column gap={24}>
            <Column gap={8}>
              <Text variant="h1" as="h1">{s.onboarding.firstCourse}</Text>
              <Text tone="secondary">课程名、考试日期、资料和老师说的重点，一屏一问。</Text>
            </Column>
            <Button variant="primary" size="lg" icon="plus" onClick={() => navigate('/courses/new?first=1', { replace: true })}>{s.action.addCourse}</Button>
            <Button variant="text" onClick={() => void skipAll()}>{s.onboarding.skipAll}</Button>
          </Column>
        )}
      </div>
    </div>
  );
}
