// 点开任务即开始（H5）：学习任务进知识点页；练习类任务新建练习；模拟卷先看题量和估算。
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import type { SessionKind, Task } from '../../api/types';
import { useStartSession } from '../practice/useStartSession';

const SESSION: Record<Exclude<Task['kind'], 'learn'>, SessionKind> = { practice: 'quick', review: 'review', mock: 'mock', mistakes: 'mistakes' };

export function useStartTask() {
  const navigate = useNavigate();
  const startSession = useStartSession();
  const [mockTask, setMockTask] = useState<Task | null>(null);
  const start = useCallback(async (task: Task) => {
    if (task.kind === 'learn') {
      const index = Math.min(task.progress?.done ?? 0, Math.max(0, task.kp_ids.length - 1));
      const kp = task.kp_ids[index] ?? task.kp_ids[0];
      if (kp) navigate(`/c/${task.course_id}/kp/${kp}?task=${task.id}`, { viewTransition: true });
      else navigate(`/c/${task.course_id}`);
      return;
    }
    if (task.session_id) {
      navigate(`/session/${task.session_id}`);
      return;
    }
    if (task.kind === 'mock') {
      setMockTask(task);
      return;
    }
    await startSession({ kind: SESSION[task.kind], course_id: task.course_id, task_id: task.id, count: task.kind === 'practice' ? 5 : undefined });
  }, [navigate, startSession]);
  const confirmMock = useCallback(async () => {
    if (!mockTask) return;
    const task = mockTask;
    setMockTask(null);
    await startSession({ kind: 'mock', course_id: task.course_id, task_id: task.id });
  }, [mockTask, startSession]);
  return { start, mockTask, confirmMock, cancelMock: () => setMockTask(null) };
}
