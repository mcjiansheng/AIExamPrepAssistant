// 一轮对话：乐观显示用户消息，流式拼接助手回复；卡片到达时刷新受影响的页面并高亮（09 第 9 节、M7）。
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { invalidate, keys } from '../../api/hooks';
import type { Card, ChatContext, Command, ID, MemoryItem, Message, Ref } from '../../api/types';
import { useUi } from '../../state/ui';

export interface LiveTool { id: ID; label: string; status: 'running' | 'done' | 'failed' }
export interface LiveReply { text: string; tools: LiveTool[]; refs: Ref[]; cards: Card[]; memory: MemoryItem[]; error: { message: string; retryable: boolean } | null; done: boolean }

export function useChat(threadId: ID | null) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Message | null>(null);
  const [live, setLive] = useState<LiveReply | null>(null);
  const [failed, setFailed] = useState<{ text: string; command?: Command } | null>(null);
  /** 最近一次完成的回复（知识点页把 AI 动作的结果留在页面上） */
  const [last, setLast] = useState<LiveReply | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = !!live && !live.done;

  const send = useCallback(async (text: string, options: { command?: Command; context?: ChatContext } = {}) => {
    if (!threadId || !text.trim()) return;
    const ui = useUi.getState();
    const { chips: _c, ...base } = ui.context;
    const context: ChatContext = options.context ?? base;
    setFailed(null);
    setPending({ id: 'pending', role: 'user', text, created_at: new Date().toISOString(), tools: [], refs: [], cards: [], memory: [], status: 'done', error: null });
    const reply: LiveReply = { text: '', tools: [], refs: [], cards: [], memory: [], error: null, done: false };
    setLive({ ...reply });
    const controller = new AbortController();
    abort.current = controller;
    try {
      for await (const event of api.send(threadId, { text, context, command: options.command }, controller.signal)) {
        if (event.type === 'text') reply.text += event.delta;
        else if (event.type === 'tool') {
          const i = reply.tools.findIndex((t) => t.id === event.id);
          if (i >= 0) reply.tools[i] = event; else reply.tools.push(event);
        } else if (event.type === 'refs') reply.refs.push(...event.refs);
        else if (event.type === 'card') {
          reply.cards.push(event.card);
          if (event.card.kind === 'change') {
            invalidate(qc, event.card.affects);
            ui.flash(event.card.affects);
          }
        } else if (event.type === 'memory') reply.memory.push(event.item);
        else if (event.type === 'error') reply.error = { message: event.message, retryable: event.retryable };
        else if (event.type === 'done') reply.done = true;
        setLive({ ...reply, tools: [...reply.tools], cards: [...reply.cards] });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        if (error instanceof ApiError && error.code === 'network') setFailed({ text, command: options.command });
        reply.error = { message: error instanceof ApiError ? error.message : '助手没有回应，可以重试', retryable: true };
      }
    }
    reply.done = true;
    setLive({ ...reply });
    setLast({ ...reply });
    await qc.invalidateQueries({ queryKey: keys.thread(threadId) });
    void qc.invalidateQueries({ queryKey: keys.threads });
    setPending(null);
    setLive(null);
  }, [threadId, qc]);

  const stop = useCallback(() => {
    abort.current?.abort();
    if (threadId) void api.stop(threadId).catch(() => undefined);
  }, [threadId]);

  return { send, stop, busy, pending, live, failed, last, clearLast: () => setLast(null) };
}
