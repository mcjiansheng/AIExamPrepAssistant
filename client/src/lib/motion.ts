// 动效工具：减少动态效果、FLIP 重排（M6）、共享元素过渡（M1）。
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import motion from '../tokens/generated/motion.json';

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  return () => observer.disconnect();
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.motion === 'reduce', () => false);
}

export function reducedMotion() {
  return document.documentElement.dataset.motion === 'reduce';
}

export const SPRING = motion.spring;

/**
 * FLIP：列表顺序或位置变化时，元素从旧位置弹簧移动到新位置，被移动的项背景高亮（M6）。
 * 给每个子元素设 data-flip="唯一键"。
 */
export function useFlip<T extends HTMLElement>(deps: unknown[]) {
  const ref = useRef<T>(null);
  const last = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>('[data-flip]')];
    const next = new Map<string, DOMRect>();
    for (const el of items) next.set(el.dataset.flip!, el.getBoundingClientRect());
    if (!reducedMotion()) {
      for (const el of items) {
        const before = last.current.get(el.dataset.flip!);
        const after = next.get(el.dataset.flip!)!;
        if (!before) continue;
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: SPRING.default.ms, easing: SPRING.default.easing },
        );
      }
    }
    last.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/** 依次延迟：第 i 个元素的动画延迟，总时长不超过 1.2 秒（M4） */
export function stagger(i: number, total: number) {
  const step = total > 1 ? Math.min(40, 1200 / total) : 0;
  return `${Math.round(i * step)}ms`;
}
