import { request, type FullConfig } from '@playwright/test';
import type { DeviceInfo, Tokens } from '../../src/api/types';

export default async function setup(config: FullConfig) {
  const project = config.projects[0]!;
  const api = await request.newContext({ baseURL: project.use.baseURL });
  try {
    const phone = '13800000000';
    const sms = await api.post('/api/v1/auth/sms', { data: { phone } });
    if (!sms.ok()) throw new Error(`演示账号验证码请求失败（HTTP ${sms.status()}）`);
    const { dev_code } = await sms.json() as { dev_code: string | null };
    if (!dev_code) throw new Error('端到端测试需要 SMS_MODE=dev');

    const device: DeviceInfo = {
      kind: 'browser',
      name: 'Playwright',
      timezone: project.use.timezoneId ?? 'America/Los_Angeles',
    };
    const login = await api.post('/api/v1/auth/login', { data: { phone, code: dev_code, device } });
    if (!login.ok()) throw new Error(`演示账号登录失败（HTTP ${login.status()}）`);
    const { access_token, refresh_token, user } = await login.json() as Tokens;
    process.env.FULLGRID_E2E_DEMO_SESSION = JSON.stringify({
      origin: new URL(project.use.baseURL!).origin,
      value: JSON.stringify({ access: access_token, refresh: refresh_token, user }),
    });
  } finally {
    await api.dispose();
  }
}
