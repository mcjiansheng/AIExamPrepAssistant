// 界面状态：助手面板、页面上下文、撤销条、提示、离线、拦截器弹层、改动高亮（对应鸿蒙端的 AppStorageV2）。
import { create } from 'zustand';
import type { Area, ChatContext, Command, Estimate, Undo } from '../api/types';

export interface ContextChip { key: keyof ChatContext; label: string }
export interface PageContext extends ChatContext { chips: ContextChip[] }
export interface Ask { text: string; command?: Command; context?: Partial<ChatContext> }
interface Pending { resolve: (ok: boolean) => void }

interface UiState {
  assistantOpen: boolean;
  assistantCollapsed: boolean;
  threadId: string | null;
  context: PageContext;
  ask: Ask | null;
  openAssistant: (threadId?: string | null) => void;
  closeAssistant: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setThread: (threadId: string | null) => void;
  setContext: (context: PageContext) => void;
  sendToAssistant: (ask: Ask) => void;
  takeAsk: () => Ask | null;

  undo: (Undo & { key: number }) | null;
  showUndo: (undo: Undo | null) => void;
  clearUndo: () => void;
  toasts: { id: number; text: string; tone: 'default' | 'danger' }[];
  toast: (text: string, tone?: 'default' | 'danger') => void;
  dismissToast: (id: number) => void;

  offline: boolean;
  setOffline: (offline: boolean) => void;

  login: Pending | null;
  connect: (Pending & { reason: string | null }) | null;
  estimate: (Pending & { estimate: Estimate }) | null;
  requestLogin: () => Promise<boolean>;
  requestConnect: (reason?: string | null) => Promise<boolean>;
  requestEstimate: (estimate: Estimate) => Promise<boolean>;
  finishLogin: (ok: boolean) => void;
  finishConnect: (ok: boolean) => void;
  finishEstimate: (ok: boolean) => void;

  highlight: { areas: Area[]; key: number } | null;
  flash: (areas: Area[]) => void;
}

const COLLAPSED = 'fullgrid.assistant.collapsed';
let seq = 0;

export const useUi = create<UiState>((set, get) => ({
  assistantOpen: false,
  assistantCollapsed: localStorage.getItem(COLLAPSED) === '1',
  threadId: null,
  context: { route: '/', chips: [] },
  ask: null,
  openAssistant: (threadId) => set((s) => ({ assistantOpen: true, assistantCollapsed: false, threadId: threadId === undefined ? s.threadId : threadId })),
  closeAssistant: () => set({ assistantOpen: false }),
  setCollapsed: (collapsed) => {
    localStorage.setItem(COLLAPSED, collapsed ? '1' : '0');
    set({ assistantCollapsed: collapsed, assistantOpen: !collapsed && get().assistantOpen });
  },
  setThread: (threadId) => set({ threadId }),
  setContext: (context) => set({ context }),
  // 页面发起的提问进当前课程的线程（threadId 置空 = 跟随页面）
  sendToAssistant: (ask) => set({ ask, threadId: null, assistantOpen: true, assistantCollapsed: false }),
  takeAsk: () => {
    const ask = get().ask;
    if (ask) set({ ask: null });
    return ask;
  },

  undo: null,
  showUndo: (undo) => set({ undo: undo ? { ...undo, key: ++seq } : null }),
  clearUndo: () => set({ undo: null }),
  toasts: [],
  toast: (text, tone = 'default') => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  offline: false,
  setOffline: (offline) => {
    if (get().offline !== offline) set({ offline });
  },

  login: null,
  connect: null,
  estimate: null,
  requestLogin: () => new Promise((resolve) => { get().login?.resolve(false); set({ login: { resolve } }); }),
  requestConnect: (reason = null) => new Promise((resolve) => { get().connect?.resolve(false); set({ connect: { resolve, reason } }); }),
  requestEstimate: (estimate) => new Promise((resolve) => { get().estimate?.resolve(false); set({ estimate: { resolve, estimate } }); }),
  finishLogin: (ok) => { get().login?.resolve(ok); set({ login: null }); },
  finishConnect: (ok) => { get().connect?.resolve(ok); set({ connect: null }); },
  finishEstimate: (ok) => { get().estimate?.resolve(ok); set({ estimate: null }); },

  highlight: null,
  flash: (areas) => set({ highlight: { areas, key: ++seq } }),
}));
