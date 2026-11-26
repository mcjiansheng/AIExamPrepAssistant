// 开关（Toggle）、分段（SubTabBar 样式）、步进、输入框、多行输入、验证码、勾选框。
import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import css from './controls.module.css';
import { Icon } from './Icon';
import type { IconName } from './icons';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={css.switch} onClick={() => onChange(!checked)} disabled={disabled} />;
}

export function Segmented<V extends string>({ value, options, onChange, label }: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta) onChange(options[(index + delta + options.length) % options.length]!.value);
  };
  return (
    <div className={css.segmented} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      <span className={css.segThumb} style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` }} aria-hidden />
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stepper({ value, onChange, min, max, step = 1, format, label }: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number; format?: (v: number) => string; label: string;
}) {
  return (
    <div className={css.stepper} role="group" aria-label={label}>
      <button type="button" aria-label="减少" onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min}><Icon name="chevronLeft" size={18} /></button>
      <output aria-live="polite">{format ? format(value) : value}</output>
      <button type="button" aria-label="增加" onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max}><Icon name="chevronRight" size={18} /></button>
    </div>
  );
}

interface FieldBase { label?: string; hideLabel?: boolean; note?: ReactNode; error?: string | null }

export function TextField({ label, hideLabel, note, error, value, onChange, placeholder, type = 'text', icon, suffix, inputMode, maxLength, autoFocus, onEnter, autoComplete, name }: FieldBase & {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: 'text' | 'password' | 'tel' | 'date' | 'time' | 'url' | 'number';
  icon?: IconName; suffix?: ReactNode; inputMode?: 'numeric' | 'tel' | 'text' | 'url'; maxLength?: number; autoFocus?: boolean; onEnter?: () => void;
  autoComplete?: string; name?: string;
}) {
  const id = useId();
  return (
    <div className={css.field}>
      {label && <label htmlFor={id} className={hideLabel ? 'sr-only' : css.fieldLabel}>{label}</label>}
      <div className={cx(css.inputWrap, error && css.invalid)}>
        {icon && <Icon name={icon} tone="tertiary" />}
        <input
          id={id} name={name} className={css.input} value={value} type={type} placeholder={placeholder} inputMode={inputMode} maxLength={maxLength}
          autoFocus={autoFocus} autoComplete={autoComplete} aria-invalid={!!error} aria-describedby={error || note ? `${id}-note` : undefined}
          onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
        />
        {suffix}
      </div>
      {(error || note) && <div id={`${id}-note`} className={error ? css.fieldError : css.fieldNote}>{error ?? note}</div>}
    </div>
  );
}

export function TextArea({ label, hideLabel, note, error, value, onChange, placeholder, minRows = 3, autoFocus, onEnter }: FieldBase & {
  value: string; onChange: (v: string) => void; placeholder?: string; minRows?: number; autoFocus?: boolean; onEnter?: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minRows * 26 + 24)}px`;
  }, [value, minRows]);
  return (
    <div className={css.field}>
      {label && <label htmlFor={id} className={hideLabel ? 'sr-only' : css.fieldLabel}>{label}</label>}
      <textarea
        id={id} ref={ref} className={css.textarea} value={value} placeholder={placeholder} autoFocus={autoFocus} aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (onEnter && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onEnter(); } }}
      />
      {(error || note) && <div className={error ? css.fieldError : css.fieldNote}>{error ?? note}</div>}
    </div>
  );
}

export function CodeField({ value, onChange, onComplete, label, error }: { value: string; onChange: (v: string) => void; onComplete: (code: string) => void; label: string; error?: string | null }) {
  const id = useId();
  return (
    <div className={css.field}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <div className={cx(css.inputWrap, error && css.invalid)}>
        <input
          id={id} className={cx(css.input, css.otp)} value={value} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="······"
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6);
            onChange(v);
            if (v.length === 6) onComplete(v);
          }}
        />
      </div>
      {error && <div className={css.fieldError} role="alert">{error}</div>}
    </div>
  );
}

export function Checkbox({ checked, onChange, children, shake }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; shake?: number }) {
  return (
    <label className={cx(css.checkRow, shake ? css.shake : undefined)} key={shake}>
      <button type="button" role="checkbox" aria-checked={checked} className={css.check} onClick={() => onChange(!checked)}>
        {checked && <Icon name="check" size={16} />}
      </button>
      <span>{children}</span>
    </label>
  );
}
