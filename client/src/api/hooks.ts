// 服务端数据：TanStack Query 按资源分键；写操作返回的 affects 决定失效哪些键（10 第 8.2 节）。
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSession } from '../state/session';
import { useUi } from '../state/ui';
import { ApiError } from './client';
import { api } from './endpoints';
import type { Area, Change, ID } from './types';

export const keys = {
  health: ['health'] as const,
  me: ['me'] as const,
  settings: ['settings'] as const,
  stats: ['stats'] as const,
  today: ['today'] as const,
  schedule: (from?: string, to?: string) => ['schedule', from ?? null, to ?? null] as const,
  courses: ['courses'] as const,
  course: (cid: ID) => ['course', cid] as const,
  home: (cid: ID) => ['courseHome', cid] as const,
  map: (cid: ID) => ['map', cid] as const,
  kp: (kid: ID, task?: ID | null) => ['kp', kid, task ?? null] as const,
  materials: (cid: ID) => ['materials', cid] as const,
  pages: (mid: ID) => ['pages', mid] as const,
  page: (mid: ID, n: number) => ['page', mid, n] as const,
  focus: (cid: ID) => ['focus', cid] as const,
  format: (cid: ID) => ['examFormat', cid] as const,
  practice: (cid?: ID | null) => ['practice', cid ?? 'all'] as const,
  session: (sid: ID) => ['session', sid] as const,
  result: (sid: ID) => ['result', sid] as const,
  mistakes: (cid?: ID | null) => ['mistakes', cid ?? 'all'] as const,
  insight: (cid: ID) => ['insight', cid] as const,
  threads: ['threads'] as const,
  thread: (tid: ID) => ['thread', tid] as const,
  presets: ['presets'] as const,
  providers: ['providers'] as const,
  models: ['models'] as const,
  usage: (period: 'week' | 'month') => ['usage', period] as const,
  limits: ['limits'] as const,
  plugins: ['plugins'] as const,
  plugin: (id: ID) => ['plugin', id] as const,
  notifications: ['notifications'] as const,
  reminders: ['reminders'] as const,
  memory: ['memory'] as const,
  devices: ['devices'] as const,
};

const AREA_PREFIXES: Record<Area, string[]> = {
  today: ['today'], schedule: ['schedule'], courses: ['courses'], course: ['course', 'courseHome'],
  map: ['courseHome', 'map', 'kp', 'courses'], kp: ['kp'], materials: ['materials', 'pages', 'page', 'courseHome'],
  focus: ['focus', 'examFormat', 'kp', 'courseHome'], practice: ['practice'], session: ['session', 'result'],
  mistakes: ['mistakes', 'practice'], insight: ['insight'], threads: ['threads', 'thread'], settings: ['settings', 'me'],
  providers: ['providers', 'models'], plugins: ['plugins', 'plugin'], notifications: ['notifications'],
};

export function invalidate(qc: QueryClient, areas: Area[]) {
  const prefixes = new Set(areas.flatMap((a) => AREA_PREFIXES[a] ?? []));
  for (const prefix of prefixes) void qc.invalidateQueries({ queryKey: [prefix] });
}

const signedIn = () => !!useSession.getState().access;

// —— 读 ——
export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health, staleTime: 60_000 });
export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me, enabled: signedIn() });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings, enabled: signedIn() });
export const useStats = () => useQuery({ queryKey: keys.stats, queryFn: api.stats });
export const useToday = () => useQuery({ queryKey: keys.today, queryFn: api.today });
export const useSchedule = (from?: string, to?: string) => useQuery({ queryKey: keys.schedule(from, to), queryFn: () => api.schedule(from, to) });
export const useCourses = () => useQuery({ queryKey: keys.courses, queryFn: api.courses });
export const useCourse = (cid: ID) => useQuery({ queryKey: keys.course(cid), queryFn: () => api.course(cid) });
export const useCourseHome = (cid: ID) => useQuery({ queryKey: keys.home(cid), queryFn: () => api.courseHome(cid) });
export const useKp = (kid: ID, task?: ID | null) => useQuery({ queryKey: keys.kp(kid, task), queryFn: () => api.kp(kid, task) });
export const useMaterials = (cid: ID) => useQuery({ queryKey: keys.materials(cid), queryFn: () => api.materials(cid) });
export const usePages = (mid: ID | null) => useQuery({ queryKey: keys.pages(mid ?? ''), queryFn: () => api.pages(mid!), enabled: !!mid });
export const usePage = (mid: ID | null, n: number) => useQuery({ queryKey: keys.page(mid ?? '', n), queryFn: () => api.page(mid!, n), enabled: !!mid && n > 0 });
export const useFocus = (cid: ID) => useQuery({ queryKey: keys.focus(cid), queryFn: () => api.focus(cid) });
export const useExamFormat = (cid: ID) => useQuery({ queryKey: keys.format(cid), queryFn: () => api.examFormat(cid) });
export const usePractice = (cid?: ID | null) => useQuery({ queryKey: keys.practice(cid), queryFn: () => api.practice(cid) });
export const useSessionData = (sid: ID) => useQuery({ queryKey: keys.session(sid), queryFn: () => api.session(sid) });
export const useResult = (sid: ID) => useQuery({ queryKey: keys.result(sid), queryFn: () => api.result(sid), retry: false });
export const useMistakes = (cid?: ID | null) => useQuery({ queryKey: keys.mistakes(cid), queryFn: () => api.mistakes(cid) });
export const useInsight = (cid: ID) => useQuery({ queryKey: keys.insight(cid), queryFn: () => api.insight(cid) });
export const useThreads = () => useQuery({ queryKey: keys.threads, queryFn: api.threads });
export const useThread = (tid: ID | null) => useQuery({ queryKey: keys.thread(tid ?? ''), queryFn: () => api.thread(tid!), enabled: !!tid });
export const usePresets = () => useQuery({ queryKey: keys.presets, queryFn: api.presets, staleTime: Infinity });
export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: api.providers });
export const useModels = () => useQuery({ queryKey: keys.models, queryFn: api.models });
export const useUsage = (period: 'week' | 'month') => useQuery({ queryKey: keys.usage(period), queryFn: () => api.usage(period) });
export const useLimits = () => useQuery({ queryKey: keys.limits, queryFn: api.limits });
export const usePlugins = () => useQuery({ queryKey: keys.plugins, queryFn: api.plugins });
export const usePlugin = (id: ID) => useQuery({ queryKey: keys.plugin(id), queryFn: () => api.plugin(id) });
export const useNotifications = () => useQuery({ queryKey: keys.notifications, queryFn: api.notifications, enabled: signedIn() });
export const useReminders = () => useQuery({ queryKey: keys.reminders, queryFn: api.reminders });
export const useMemory = () => useQuery({ queryKey: keys.memory, queryFn: api.memory });
export const useDevices = () => useQuery({ queryKey: keys.devices, queryFn: api.devices });

/** 当前是否连好了可用的模型 */
export function useAiReady() {
  const providers = useProviders();
  return { ready: !!providers.data?.some((p) => p.status === 'ok'), loading: providers.isLoading };
}

// —— 写 ——
export function errorText(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return '操作没有完成，请重试';
}

/** 执行一个返回 Change<T> 的操作：刷新受影响的页面、显示撤销条、高亮被改的区域 */
export function useApply() {
  const qc = useQueryClient();
  return useCallback(async <R,>(run: () => Promise<Change<R>>, options: { undo?: boolean } = {}) => {
    const ui = useUi.getState();
    try {
      const change = await run();
      invalidate(qc, change.affects);
      if (change.undo && options.undo !== false) ui.showUndo(change.undo);
      return change.result;
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'network')) ui.toast(errorText(error), 'danger');
      throw error;
    }
  }, [qc]);
}

/** 普通写操作：失败时给出原因，成功后刷新指定区域 */
export function useAction() {
  const qc = useQueryClient();
  return useCallback(async <R,>(run: () => Promise<R>, areas: Area[] = []) => {
    try {
      const result = await run();
      invalidate(qc, areas);
      return result;
    } catch (error) {
      useUi.getState().toast(errorText(error), 'danger');
      throw error;
    }
  }, [qc]);
}

export function useUndo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ID) => api.undo(id),
    onSuccess: (data) => {
      invalidate(qc, data.affects);
      useUi.getState().toast(data.summary);
    },
    onError: (error) => useUi.getState().toast(errorText(error), 'danger'),
  });
}
