// 登录：手机号 + 验证码（新号码自动注册）；平板和电脑可以扫码登录（05 第 2.2 节）。
import { useEffect, useState } from 'react';
import { useApiMode } from '../../App';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import type { QrStatus, Tokens } from '../../api/types';
import { deviceInfo } from '../../lib/device';
import { isCompact, useBreakpoint } from '../../state/breakpoint';
import { useSession } from '../../state/session';
import { s } from '../../strings/zh-CN';
import { Button } from '../../ui/Button';
import { Checkbox, CodeField, Segmented, TextField } from '../../ui/Inputs';
import { Text } from '../../ui/Text';
import { Column, Row } from '../../layout';
import { QrPattern } from './QrPattern';

export function LoginForm({ onDone }: { onDone: (tokens: Tokens) => void }) {
  const bp = useBreakpoint();
  const [tab, setTab] = useState<'code' | 'qr'>('code');
  return (
    <Column gap={24}>
      {!isCompact(bp) && (
        <Segmented label="登录方式" value={tab} onChange={setTab} options={[{ value: 'code', label: s.auth.codeLogin }, { value: 'qr', label: s.auth.qr }]} />
      )}
      {tab === 'code' || isCompact(bp) ? <CodeLogin onDone={onDone} /> : <QrLogin onDone={onDone} />}
    </Column>
  );
}

function CodeLogin({ onDone }: { onDone: (tokens: Tokens) => void }) {
  const mode = useApiMode();
  const signIn = useSession((st) => st.signIn);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [shake, setShake] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^1\d{10}$/.test(phone);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  const send = async () => {
    setError(null);
    try {
      const r = await api.sms(phone);
      setCooldown(r.cooldown_sec);
      setDevCode(r.dev_code);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '验证码没有发出去，请重试');
    }
  };
  const [agreeHint, setAgreeHint] = useState(false);
  const login = async (value = code) => {
    // 没勾协议时提示勾选，而不是拒绝（05 第 2.1 节）；提示放在勾选框旁边
    if (!agree) { setShake((n) => n + 1); setAgreeHint(true); return; }
    if (!valid || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.login(phone, value, deviceInfo());
      signIn(tokens);
      onDone(tokens);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '登录没有成功，请重试');
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Column gap={16}>
      <TextField
        label={s.auth.phone} hideLabel value={phone} onChange={(v) => setPhone(v.replace(/\D/g, '').slice(0, 11))} placeholder={s.auth.phone}
        type="tel" inputMode="tel" autoComplete="tel-national" icon="phone"
        suffix={<Button variant="text" size="sm" disabled={!valid || cooldown > 0} onClick={send}>{cooldown > 0 ? s.auth.resend(cooldown) : s.auth.getCode}</Button>}
      />
      <CodeField label={s.auth.code} value={code} onChange={setCode} onComplete={(v) => void login(v)} error={error} />
      {devCode && <Text variant="caption" tone="tertiary">{s.auth.devCode(devCode)}</Text>}
      <Column gap={4}>
        <Checkbox checked={agree} onChange={(v) => { setAgree(v); if (v) setAgreeHint(false); }} shake={shake}>
          {s.auth.agree}<a href="/me/about#terms" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{s.auth.terms}</a>和<a href="/me/about#privacy" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{s.auth.privacy}</a>
        </Checkbox>
        {agreeHint && !agree && <Text variant="caption" tone="danger">{s.auth.agreeFirst}</Text>}
      </Column>
      <Button variant="primary" size="lg" block loading={busy} disabled={!valid || code.length !== 6} onClick={() => void login()}>{s.action.login}</Button>
      {mode === 'mock' && (
        <Row gap={4} justify="center" wrap>
          <Text variant="caption" tone="tertiary" as="span">演示账号 13800000000 有三门课的完整记录</Text>
          <Button variant="text" size="sm" onClick={() => setPhone('13800000000')}>填入</Button>
        </Row>
      )}
    </Column>
  );
}

function QrLogin({ onDone }: { onDone: (tokens: Tokens) => void }) {
  const signIn = useSession((st) => st.signIn);
  const [ticket, setTicket] = useState<{ id: string; payload: string } | null>(null);
  const [status, setStatus] = useState<QrStatus['status']>('waiting');
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    setStatus('waiting');
    void api.qr(deviceInfo()).then((t) => { if (alive) setTicket(t); });
    return () => { alive = false; };
  }, [round]);
  useEffect(() => {
    if (!ticket || status === 'expired' || status === 'confirmed') return;
    const t = setInterval(async () => {
      const r = await api.qrStatus(ticket.id).catch(() => null);
      if (!r) return;
      setStatus(r.status);
      if (r.status === 'confirmed' && r.tokens) { signIn(r.tokens); onDone(r.tokens); }
    }, 1500);
    return () => clearInterval(t);
  }, [ticket, status, signIn, onDone]);
  return (
    <Column gap={16} align="center">
      <div style={{ padding: 16, borderRadius: 20, background: '#fff', opacity: status === 'expired' ? 0.3 : 1 }}>
        {ticket ? <QrPattern seed={ticket.payload} size={184} /> : <div style={{ width: 184, height: 184 }} />}
      </div>
      <Text tone={status === 'scanned' ? 'accent' : 'secondary'} center>
        {status === 'scanned' ? s.auth.qrScanned : status === 'expired' ? s.auth.qrExpired : s.auth.qrWaiting}
      </Text>
      {status === 'expired' && <Button variant="secondary" icon="retry" onClick={() => setRound((n) => n + 1)}>{s.auth.refreshQr}</Button>}
    </Column>
  );
}
