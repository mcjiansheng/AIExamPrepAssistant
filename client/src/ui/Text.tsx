// 文字（ArkUI Text）：字号、行高、字重只来自 07 第 3 节的字阶。
import { createElement, type ReactNode } from 'react';
import { cx } from '../lib/cx';
import css from './controls.module.css';

export type TextVariant = 'display' | 'h1' | 'h2' | 'h3' | 'body' | 'bodySm' | 'caption' | 'label';
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'success' | 'warning' | 'onAccent' | 'inherit';

export interface TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  as?: 'p' | 'span' | 'h1' | 'h2' | 'h3' | 'div' | 'strong' | 'label' | 'output';
  lines?: number;
  nowrap?: boolean;
  strong?: boolean;
  center?: boolean;
  id?: string;
  htmlFor?: string;
  children: ReactNode;
}

export function Text({ variant = 'body', tone = 'primary', as = 'p', lines, nowrap, strong, center, id, htmlFor, children }: TextProps) {
  return createElement(as, {
    id,
    htmlFor,
    className: cx(css[`t-${variant}`], tone !== 'inherit' && css[`tone-${tone}`], strong && css.strong, lines && css.clamp, nowrap && css.nowrap, center && css.center),
    style: lines ? { WebkitLineClamp: lines } : undefined,
  }, children);
}

/** 正文里的 **加粗**（讲解、助手回复） */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p))}</>;
}
