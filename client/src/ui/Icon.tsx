// 图标：24 网格、1.5 线宽、圆角端点（07 第 5 节）。对应 ArkUI 的 SymbolGlyph($r('sys.symbol.xxx'))。
import { ICONS, type IconName } from './icons';

export interface IconProps {
  name: IconName;
  size?: 16 | 18 | 20 | 24 | 28 | 32;
  /** 有含义的图标要给读屏文字；纯装饰的不要 */
  label?: string;
  tone?: 'inherit' | 'secondary' | 'tertiary' | 'accent' | 'danger' | 'success' | 'warning';
}

const TONE: Record<NonNullable<IconProps['tone']>, string | undefined> = {
  inherit: undefined,
  secondary: 'var(--text-secondary)',
  tertiary: 'var(--text-tertiary)',
  accent: 'var(--accent)',
  danger: 'var(--danger)',
  success: 'var(--success)',
  warning: 'var(--warning)',
};

export function Icon({ name, size = 20, label, tone = 'inherit' }: IconProps) {
  const Glyph = ICONS[name][0];
  return (
    <Glyph
      size={size}
      strokeWidth={1.5}
      color={TONE[tone] ?? 'currentColor'}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      style={{ flex: 'none' }}
    />
  );
}
