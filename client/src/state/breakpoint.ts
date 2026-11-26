// 鸿蒙横向断点：xs < 320 ≤ sm < 600 ≤ md < 840 ≤ lg < 1440 ≤ xl（vp ≈ CSS px）。布局分支只看这个值（08 第 1.3 节）。
import { useSyncExternalStore } from 'react';
import tokens from '../tokens/tokens.json';

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
const { sm, md, lg, xl } = tokens.breakpoint;

export function breakpointOf(width: number): Breakpoint {
  if (width >= xl) return 'xl';
  if (width >= lg) return 'lg';
  if (width >= md) return 'md';
  if (width >= sm) return 'sm';
  return 'xs';
}

function subscribe(callback: () => void) {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, () => breakpointOf(window.innerWidth), () => 'lg');
}

/** sm 及以下是手机布局 */
export const isCompact = (bp: Breakpoint) => bp === 'xs' || bp === 'sm';
export const isWide = (bp: Breakpoint) => bp === 'lg' || bp === 'xl';
