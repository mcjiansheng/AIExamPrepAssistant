// 助手面板：线程、当前模型、消息与卡片、上下文标签、/ 命令、发送与停止（06 第 15 节）。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { keys, useModels, useProviders, useThread, useThreads } from '../../api/hooks';
import type { Command, ID, Message, Thread } from '../../api/types';
import { cx } from '../../lib/cx';
import { useUi } from '../../state/ui';
import { s } from '../../strings/zh-CN';
import { RefChip } from '../../ui/Blocks';
import { Button, IconButton } from '../../ui/Button';
import { Chip } from '../../ui/Chip';
import { Skeleton } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Sheet';
import { RichText, Text } from '../../ui/Text';
import { Row } from '../../layout';
import { useQueryClient } from '@tanstack/react-query';
import css from './assistant.module.css';
import { ChatCard, type CardHandlers } from './Cards';
import { useChat, type LiveReply } from './useChat';

const COMMANDS: { cmd: string; label: string; text: (kp?: string) => string; command?: Command }[] = [
  { cmd: '/今天', label: '今天先做什么', text: () => '今天先做什么？', command: 'today' },
  { cmd: '/出题', label: '来 5 道题', text: (kp) => (kp ? `来 3 道${kp}的题` : '来 5 道题') },
  { cmd: '/讲解', label: '讲讲当前知识点', text: (kp) => (kp ? `讲讲${kp}` : '讲讲') },
  { cmd: '/复盘', label: '复盘最近的练习', text: () => '帮我复盘最近的练习', command: 'review' },
];

function pickThread(threads: Thread[] | undefined, chosen: ID | null, courseId?: ID) {
  if (!threads) return null;
  if (chosen && threads.some((t) => t.id === chosen)) return threads.find((t) => t.id === chosen)!;
  return threads.find((t) => t.kind === 'course' && t.course_id === courseId) ?? threads.find((t) => t.kind === 'global') ?? threads[0] ?? null;
}

export function AssistantPanel({ onClose, onCollapse, embedded, threadOverride }: { onClose?: () => void; onCollapse?: () => void; embedded?: boolean; threadOverride?: ID }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const threads = useThreads();
  const context = useUi((st) => st.context);
  const chosen = useUi((st) => st.threadId);
  const setThread = useUi((st) => st.setThread);
  const thread = pickThread(threads.data, threadOverride ?? chosen, context.course_id);
  const data = useThread(thread?.id ?? null);
  const chat = useChat(thread?.id ?? null);
  const models = useModels();
  const providers = useProviders();
  const [text, setText] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const chips = context.chips.filter((c) => !hidden.includes(c.key));
  useEffect(() => setHidden([]), [context.route]);
  const kpTitle = context.chips.find((c) => c.key === 'kp_id')?.label.split(' · ').pop();

  const send = (value: string, command?: Command, kpId?: ID | null) => {
    const { chips: all, ...base } = useUi.getState().context;
    const ctx = { ...base };
    for (const key of hidden) delete (ctx as Record<string, unknown>)[key];
    if (kpId) ctx.kp_id = kpId;
    void all;
    void chat.send(value, { command, context: ctx });
    setText('');
  };
  // 页面发起的提问（知识点页的 AI 动作、“问助手”）
  const ask = useUi((st) => st.ask);
  useEffect(() => {
    if (!ask || !thread) return;
    const taken = useUi.getState().takeAsk();
    if (!taken) return;
    const { chips: _c, ...base } = useUi.getState().context;
    void chat.send(taken.text, { command: taken.command, context: { ...base, ...taken.context } });
  }, [ask, thread, chat]);

  const messages = data.data?.messages ?? [];
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, chat.live?.text, chat.live?.cards.length, chat.pending]);

  const currentModel = thread?.model ?? models.data?.roles.chat?.model ?? null;
  const modelItems = useMemo(() => (providers.data ?? []).filter((p) => p.status === 'ok').flatMap((p) => p.models.map((m) => ({
    label: `${p.name} · ${m}`,
    onSelect: () => thread && void api.updateThread(thread.id, { model: m }).then(() => qc.invalidateQueries({ queryKey: keys.threads })),
  }))), [providers.data, thread, qc]);

  const handlers: CardHandlers = {
    threadId: thread?.id ?? null,
    ask: (t, command, kpId) => send(t, command, kpId),
    resend: () => {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      if (last) send(last.text);
    },
    leave: () => onClose?.(),
  };
  const showCommands = text.startsWith('/') && !text.includes(' ');
  const commands = COMMANDS.filter((c) => c.cmd.startsWith(text));
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (showCommands && commands.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % commands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + commands.length) % commands.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const c = commands[cmdIndex] ?? commands[0]!; send(c.text(kpTitle), c.command); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!chat.busy) send(text.trim()); }
  };
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  const suggestions = context.kp_id ? [s.kp.simplify, s.kp.example, s.kp.quizMe]
    : context.course_id ? ['这门课我还差多少', '来 5 道题', '老师说：'] : ['今天只有 1 小时', '我是不是来不及了', '来 5 道题'];

  return (
    <div className={cx(css.panel, embedded && css.embedded)}>
      <div className={css.head}>
        <Menu
          icon="thread"
          label={s.assistant.history}
          items={[
            ...(threads.data ?? []).map((t) => ({ label: t.kind === 'global' ? s.assistant.global : t.title, icon: (t.id === thread?.id ? 'check' : 'thread') as 'check', onSelect: () => setThread(t.id) })),
            { label: s.assistant.newThread, icon: 'compose' as const, onSelect: async () => { const t = await api.createThread({ course_id: context.course_id ?? null, title: s.assistant.newThread }); await qc.invalidateQueries({ queryKey: keys.threads }); setThread(t.id); } },
          ]}
        />
        <div className={css.titleBtn}><span>{thread ? (thread.kind === 'global' ? s.assistant.global : thread.title) : s.assistant.title}</span></div>
        {currentModel && (modelItems.length > 1 ? (
          <Menu icon="bot" label={`${s.assistant.model}：${currentModel}`} items={modelItems} note={`${s.assistant.model}：${currentModel}`} />
        ) : <span className={css.model} title={s.assistant.model}>{currentModel}</span>)}
        {thread && <IconButton icon="expand" label="全屏打开" size="sm" onClick={() => { onClose?.(); navigate(`/chat/${thread.id}`); }} />}
        {onCollapse && <IconButton icon="panelClose" label="收起助手" onClick={onCollapse} />}
        {onClose && !embedded && <IconButton icon="close" label={s.action.close} onClick={onClose} />}
      </div>

      <div className={css.list} ref={list} aria-live="polite">
        {data.isLoading && <><Skeleton height={40} width="70%" /><Skeleton height={64} /></>}
        {thread && !data.isLoading && messages.length === 0 && !chat.pending && (
          <div className={css.empty}>
            <Text variant="caption" tone="tertiary">{s.assistant.suggestions}</Text>
            <div className={css.suggest}>{suggestions.map((t) => <Chip key={t} onClick={() => (t.endsWith('：') ? (setText(t), input.current?.focus()) : send(t, t === s.kp.simplify ? 'simplify' : t === s.kp.example ? 'example' : t === s.kp.quizMe ? 'quiz' : undefined))}>{t}</Chip>)}</div>
          </div>
        )}
        {messages.map((m) => <MessageView key={m.id} m={m} h={handlers} />)}
        {chat.pending && <div className={css.user}>{chat.pending.text}</div>}
        {chat.live && <LiveView live={chat.live} h={handlers} />}
        {chat.failed && (
          <div className={css.error}><Icon name="warning" size={16} />{s.assistant.unsent}<Button size="sm" variant="text" onClick={() => send(chat.failed!.text, chat.failed!.command)}>{s.assistant.resend}</Button></div>
        )}
      </div>

      <div className={css.composer}>
        {showCommands && commands.length > 0 && (
          <div className={css.commands} role="listbox" aria-label="命令">
            {commands.map((c, i) => (
              <button key={c.cmd} type="button" role="option" aria-selected={i === cmdIndex} className={cx(css.command, i === cmdIndex && css.commandActive)} onClick={() => send(c.text(kpTitle), c.command)}>
                <kbd>{c.cmd}</kbd><span>{c.label}</span>
              </button>
            ))}
          </div>
        )}
        {chips.length > 0 && (
          <div className={css.chips} aria-label="上下文">
            {chips.map((c) => (
              <span key={c.key} className={css.ctx}>{c.label}<button type="button" aria-label={`不带上：${c.label}`} onClick={() => setHidden((h) => [...h, c.key])}><Icon name="close" size={16} /></button></span>
            ))}
          </div>
        )}
        <div className={css.inputRow}>
          <textarea
            ref={input} className={css.input} rows={1} value={text} placeholder={s.assistant.placeholder} aria-label={s.assistant.placeholder}
            onChange={(e) => { setText(e.target.value); setCmdIndex(0); }} onKeyDown={onKey}
          />
          {chat.busy
            ? <IconButton icon="stop" label={s.action.stop} variant="filled" onClick={chat.stop} />
            : <IconButton icon="send" label={s.action.send} variant="accent" disabled={!text.trim() || !thread} onClick={() => send(text.trim())} />}
        </div>
      </div>
    </div>
  );
}

function toolSummary(labels: string[]) {
  if (!labels.length) return null;
  return labels.join(' · ');
}

function MessageView({ m, h }: { m: Message; h: CardHandlers }) {
  if (m.role === 'user') return <div className={css.user}>{m.text}</div>;
  const tools = toolSummary(m.tools.map((t) => t.label));
  return (
    <div className={css.reply}>
      {tools && <div className={css.tools}><Icon name="check" size={16} />{tools}</div>}
      {m.text && <div className={css.replyText}><RichText text={m.text} /></div>}
      {m.refs.length > 0 && <Row gap={8} wrap>{m.refs.slice(0, 3).map((r, i) => <RefChip key={i} source={r} />)}</Row>}
      {m.cards.map((c) => <ChatCard key={c.id} card={c} h={h} />)}
      {m.memory.map((item) => <div key={item.id} className={css.memory}><Icon name="brain" size={16} />{s.assistant.remembered(item.text)}</div>)}
      {m.status === 'stopped' && <Text variant="caption" tone="tertiary">{s.assistant.stopped}</Text>}
      {m.error && <div className={css.error}>{m.error.message}</div>}
    </div>
  );
}

function LiveView({ live, h }: { live: LiveReply; h: CardHandlers }) {
  const running = live.tools.find((t) => t.status === 'running');
  const done = live.tools.filter((t) => t.status !== 'running').map((t) => t.label);
  return (
    <div className={css.reply}>
      {(done.length > 0 || running) && (
        <div className={css.tools}>
          <Icon name={running ? 'hourglass' : 'check'} size={16} />
          <span className={running ? css.toolRunning : undefined}>{[...done, running?.label].filter(Boolean).join(' · ')}</span>
        </div>
      )}
      {(live.text || !live.done) && <div className={css.replyText}><RichText text={live.text} />{!live.done && <span className={css.cursor} aria-hidden />}</div>}
      {live.refs.length > 0 && <Row gap={8} wrap>{live.refs.slice(0, 3).map((r, i) => <RefChip key={i} source={r} />)}</Row>}
      {live.cards.map((c) => <ChatCard key={c.id} card={c} h={h} />)}
      {live.memory.map((item) => <div key={item.id} className={css.memory}><Icon name="brain" size={16} />{s.assistant.remembered(item.text)}</div>)}
      {live.error && <div className={css.error}><Icon name="warning" size={16} />{live.error.message}</div>}
    </div>
  );
}
