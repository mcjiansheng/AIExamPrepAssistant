import type { DeviceInfo } from '../api/types';
import { breakpointOf } from '../state/breakpoint';

export function deviceInfo(): DeviceInfo {
  const bp = breakpointOf(window.innerWidth);
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '浏览器';
  const os = /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Android|HarmonyOS/.test(ua) ? '手机' : '';
  return {
    kind: bp === 'xs' || bp === 'sm' ? 'phone' : bp === 'md' ? 'tablet' : 'browser',
    name: `${os ? `${os} ` : ''}${browser}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
