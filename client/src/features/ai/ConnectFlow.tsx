// 连接 AI：选服务商 → 填密钥 → 检查连接（04 第 2.1 节）。首次引导、设置、当场三处共用。
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { usePresets } from '../../api/hooks';
import type { CheckResult, Preset } from '../../api/types';
import { cx } from '../../lib/cx';
import { s } from '../../strings/zh-CN';
import { Button, IconButton } from '../../ui/Button';
import { Skeleton } from '../../ui/Feedback';
import { Icon } from '../../ui/Icon';
import { TextField } from '../../ui/Inputs';
import { Card } from '../../ui/Surfaces';
import { Text } from '../../ui/Text';
import { Column, Grid, Row } from '../../layout';
import css from './connect.module.css';

type Step = 1 | 2 | 3;
const CUSTOM = 'custom';

export function ConnectFlow({ onDone, visionOnly = false }: { onDone: () => void; visionOnly?: boolean }) {
  const presets = usePresets();
  const [step, setStep] = useState<Step>(1);
  const [preset, setPreset] = useState<Preset | typeof CUSTOM | null>(null);
  const [more, setMore] = useState(false);
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [custom, setCustom] = useState({ name: '', base_url: '', model: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const list = (presets.data ?? []).filter((p) => !visionOnly || p.models.some((m) => m.vision));
  const shown = more ? list : list.slice(0, 4);
  useEffect(() => {
    if (!result) return;
    if (revealed >= result.steps.length) return;
    const t = setTimeout(() => setRevealed((n) => n + 1), 380);
    return () => clearTimeout(t);
  }, [result, revealed]);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = preset === CUSTOM
        ? { name: custom.name || '自定义服务商', protocol: 'openai' as const, base_url: custom.base_url, key, model: custom.model || undefined }
        : { preset_id: (preset as Preset).id, key };
      const conn = await api.addProvider(body);
      setStep(3);
      setResult(null);
      setRevealed(0);
      const r = await api.checkProvider(conn.id);
      if (!r.steps[0]?.ok) {
        await api.removeProvider(conn.id).catch(() => undefined);
        setStep(2);
        setError(r.steps[0]?.message ?? '连接没有成功');
      } else setResult(r);
    } catch (e) {
      setStep(2);
      setError(e instanceof ApiError ? e.message : '连接没有成功，请检查密钥');
    } finally {
      setBusy(false);
    }
  };

  const name = preset === CUSTOM ? custom.name || '自定义服务商' : preset?.name ?? '';
  return (
    <Column gap={24}>
      <div className={css.dots} aria-label={`第 ${step} 步，共 3 步`}>{[1, 2, 3].map((n) => <span key={n} className={cx(css.dot, n <= step && css.on)} />)}</div>

      {step === 1 && (
        <Column gap={16}>
          <Text variant="h2">{s.ai.step1}</Text>
          {presets.isLoading ? <Grid columns={2} gap={12}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={84} radius={16} />)}</Grid> : (
            <Grid columns={{ xs: 1, sm: 2 }} gap={12}>
              {shown.map((p) => (
                <Card key={p.id} tone="sunken" onClick={() => { setPreset(p); setStep(2); setError(null); }} label={p.name}>
                  <Row justify="between" gap={8}>
                    <Text variant="h3">{p.name}</Text>
                    <span className={css.tier} aria-label={`价格${s.ai.priceTier[p.price_tier]}`}>{'¥'.repeat(p.price_tier)}</span>
                  </Row>
                  <Text variant="bodySm" tone="secondary">{p.tagline}</Text>
                </Card>
              ))}
            </Grid>
          )}
          <Row gap={8} wrap>
            {!more && list.length > 4 && <Button variant="text" iconRight="chevronDown" onClick={() => setMore(true)}>{s.ai.more}</Button>}
            {!visionOnly && <Button variant="text" icon="link" onClick={() => { setPreset(CUSTOM); setStep(2); }}>{s.ai.custom}</Button>}
          </Row>
        </Column>
      )}

      {step === 2 && preset && (
        <Column gap={16}>
          <Row gap={4}>
            <IconButton icon="back" label={s.action.back} onClick={() => setStep(1)} size="sm" />
            <Text variant="h2">{name}</Text>
          </Row>
          {preset === CUSTOM && (
            <>
              <TextField label={s.ai.name} value={custom.name} onChange={(v) => setCustom({ ...custom, name: v })} placeholder="例如：学校的模型服务" />
              <TextField label={s.ai.baseUrl} value={custom.base_url} onChange={(v) => setCustom({ ...custom, base_url: v })} placeholder="https://api.example.com/v1" type="url" note="填根地址会自动拼接 /chat/completions；以 # 结尾表示完整地址" />
              <TextField label={s.ai.modelName} value={custom.model} onChange={(v) => setCustom({ ...custom, model: v })} placeholder="可留空，检查时自动拉取" />
            </>
          )}
          <TextField
            label={s.ai.keyLabel} value={key} onChange={setKey} placeholder="sk-…" type={show ? 'text' : 'password'} icon="key" autoComplete="off" error={error}
            onEnter={() => key.length >= 8 && void check()}
            suffix={<IconButton icon={show ? 'eyeOff' : 'eye'} label={show ? '隐藏密钥' : '显示密钥'} size="sm" onClick={() => setShow((v) => !v)} />}
          />
          {preset !== CUSTOM && (
            <div>
              <Button variant="text" size="sm" iconRight={helpOpen ? 'chevronUp' : 'chevronDown'} onClick={() => setHelpOpen((v) => !v)}>{s.ai.keyHelp}</Button>
              {helpOpen && (
                <ol className={css.help}>
                  {preset.key_steps.map((t, i) => <li key={i}><span>{i + 1}</span>{t}</li>)}
                  <li><a href={preset.key_url} target="_blank" rel="noreferrer" className={css.link}>打开 {preset.name} 控制台<Icon name="external" size={16} /></a></li>
                </ol>
              )}
            </div>
          )}
          <Row gap={8} align="start">
            <Icon name="shield" size={16} tone="tertiary" />
            <Text variant="caption" tone="tertiary">{s.ai.privacy}</Text>
          </Row>
          <Button variant="primary" size="lg" block loading={busy} disabled={key.trim().length < 8 || (preset === CUSTOM && !custom.base_url)} onClick={() => void check()}>{s.ai.step3}</Button>
        </Column>
      )}

      {step === 3 && (
        <Column gap={16}>
          <Text variant="h2">{result && revealed >= result.steps.length ? s.ai.connected(name) : s.ai.checking}</Text>
          <ul className={css.checks} aria-live="polite">
            {(result?.steps ?? []).slice(0, revealed).map((st) => (
              <li key={st.id} className={css.checkRow}>
                <Icon name={st.ok ? 'checkCircle' : 'wrongCircle'} tone={st.ok ? 'success' : 'tertiary'} />
                <div>
                  <Text>{s.check[st.id]}</Text>
                  {st.message && <Text variant="caption" tone="secondary">{st.message}</Text>}
                </div>
              </li>
            ))}
            {(!result || revealed < result.steps.length) && <li className={css.checkRow}><span className={css.spinner} /><Text tone="secondary">{s.ai.checking}</Text></li>}
          </ul>
          {result && revealed >= result.steps.length && (
            <Button variant="primary" size="lg" block onClick={onDone}>{s.action.done}</Button>
          )}
        </Column>
      )}
    </Column>
  );
}
