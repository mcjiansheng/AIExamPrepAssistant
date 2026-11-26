// 页面告诉助手“用户在看什么”（H9）；被助手改动的区域高亮一次（M7）。
import { useEffect } from 'react';
import type { Area } from '../../api/types';
import { useUi, type PageContext } from '../../state/ui';

export function usePageContext(context: PageContext | null) {
  const setContext = useUi((st) => st.setContext);
  const key = JSON.stringify(context);
  useEffect(() => {
    if (context) setContext(context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setContext]);
}

export function useHighlight(...areas: Area[]): number | null {
  const highlight = useUi((st) => st.highlight);
  if (!highlight) return null;
  return highlight.areas.some((a) => areas.includes(a)) ? highlight.key : null;
}
