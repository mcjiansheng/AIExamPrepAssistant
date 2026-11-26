// 请求层：统一加令牌、幂等键，统一拦截 401 / login_required / ai_required / needs_confirmation（10 第 8.3 节）。
import type { ApiErrorBody, ChatEvent, ErrorCode, Estimate } from './types';

export const BASE = '/api/v1';

export type Transport = (request: Request) => Promise<Response>;
let transport: Transport = (request) => fetch(request);
export function setTransport(next: Transport) {
  transport = next;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly hint: string | null = null,
    readonly detail: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

interface Hooks {
  accessToken: () => string | null;
  refresh: () => Promise<boolean>;
  signedOut: () => void;
  loginRequired: () => Promise<boolean>;
  aiRequired: () => Promise<boolean>;
  confirmEstimate: (estimate: Estimate) => Promise<boolean>;
  network: (online: boolean) => void;
}
const hooks: Hooks = {
  accessToken: () => null,
  refresh: async () => false,
  signedOut: () => {},
  loginRequired: async () => false,
  aiRequired: async () => false,
  confirmEstimate: async () => false,
  network: () => {},
};
export function configureClient(next: Partial<Hooks>) {
  Object.assign(hooks, next);
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** 关掉自动拦截，例如登录接口自己处理 401 */
  raw?: boolean;
}

type Body = Record<string, unknown> | FormData | undefined;

function newKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function build(method: string, path: string, body: Body, key: string | null, signal?: AbortSignal) {
  const headers = new Headers();
  const token = hooks.accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (key) headers.set('Idempotency-Key', key);
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    payload = JSON.stringify(body);
  }
  return new Request(`${BASE}${path}`, { method, headers, body: payload, signal });
}

async function failure(response: Response): Promise<ApiError> {
  try {
    const data = (await response.json()) as ApiErrorBody;
    const e = data.error;
    return new ApiError(response.status, e.code, e.message, e.hint ?? null, e.detail ?? null);
  } catch {
    return new ApiError(response.status, 'internal', '服务暂时没有响应，请稍后重试');
  }
}

async function send(method: string, path: string, body: Body, options: RequestOptions = {}): Promise<Response> {
  const key = method === 'POST' ? newKey() : null;
  let current = body;
  for (let round = 0; round < 3; round += 1) {
    let response: Response;
    try {
      response = await transport(build(method, path, current, key, options.signal));
      hooks.network(true);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      hooks.network(false);
      throw new ApiError(0, 'network', '网络连接中断，恢复后可以重试');
    }
    if (response.ok || options.raw) return response;
    const error = await failure(response);
    if (error.status === 401) {
      if (round === 0 && (await hooks.refresh())) continue;
      hooks.signedOut();
      throw error;
    }
    if (error.code === 'login_required' && (await hooks.loginRequired())) continue;
    if (error.code === 'ai_required' && (await hooks.aiRequired())) continue;
    if (error.code === 'needs_confirmation' && current && !(current instanceof FormData)) {
      const estimate = error.detail?.estimate as Estimate | undefined;
      if (estimate && (await hooks.confirmEstimate(estimate))) {
        current = { ...current, confirm: true };
        continue;
      }
    }
    throw error;
  }
  throw new ApiError(409, 'conflict', '操作没有完成，请重试');
}

export async function request<T>(method: string, path: string, body?: Body, options?: RequestOptions): Promise<T> {
  const response = await send(method, path, body, options);
  if (!response.ok) throw await failure(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 对话消息：读 application/x-ndjson，每行一个事件 */
export async function* streamEvents(path: string, body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const response = await send('POST', path, body, { signal });
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line) as ChatEvent;
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as ChatEvent;
}

export const http = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: Body, options?: RequestOptions) => request<T>('POST', path, body ?? {}, options),
  patch: <T>(path: string, body: Body, options?: RequestOptions) => request<T>('PATCH', path, body, options),
  put: <T>(path: string, body: Body, options?: RequestOptions) => request<T>('PUT', path, body, options),
  del: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, undefined, options),
};
