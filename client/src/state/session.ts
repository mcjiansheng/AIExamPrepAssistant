// 登录状态：令牌和当前用户，存在 localStorage（对应鸿蒙端的 Preferences；令牌不放进 AppStorage 以外的地方）。
import { create } from 'zustand';
import type { Tokens, User } from '../api/types';

const KEY = 'fullgrid.session';

interface Saved { access: string; refresh: string; user: User }
interface SessionState {
  access: string | null;
  refresh: string | null;
  user: User | null;
  signIn: (tokens: Tokens) => void;
  setUser: (user: User) => void;
  signOut: () => void;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(state: Saved | null) {
  if (state) localStorage.setItem(KEY, JSON.stringify(state));
  else localStorage.removeItem(KEY);
}

const initial = load();

export const useSession = create<SessionState>((set, get) => ({
  access: initial?.access ?? null,
  refresh: initial?.refresh ?? null,
  user: initial?.user ?? null,
  signIn: (tokens) => {
    save({ access: tokens.access_token, refresh: tokens.refresh_token, user: tokens.user });
    set({ access: tokens.access_token, refresh: tokens.refresh_token, user: tokens.user });
  },
  setUser: (user) => {
    const { access, refresh } = get();
    if (access && refresh) save({ access, refresh, user });
    set({ user });
  },
  signOut: () => {
    save(null);
    set({ access: null, refresh: null, user: null });
  },
}));
