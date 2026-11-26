// 开始一次练习：新建后立即进入作答页，第一道出好就能做（先出后核）。连接 AI、用量确认由请求层拦截处理。
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { errorText, invalidate, keys } from '../../api/hooks';
import type { NewSession } from '../../api/types';
import { useUi } from '../../state/ui';

export function useStartSession() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  return useCallback(async (input: NewSession) => {
    try {
      const session = await api.createSession(input);
      qc.setQueryData(keys.session(session.id), session);
      invalidate(qc, ['practice', 'today']);
      navigate(`/session/${session.id}`, { viewTransition: true });
      return session;
    } catch (error) {
      const dismissed = error instanceof ApiError && (error.code === 'needs_confirmation' || error.code === 'ai_required' || error.code === 'login_required');
      if (!dismissed) useUi.getState().toast(errorText(error), 'danger');
      return null;
    }
  }, [navigate, qc]);
}
