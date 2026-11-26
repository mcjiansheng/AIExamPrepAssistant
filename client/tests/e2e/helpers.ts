import { expect, type Page } from '@playwright/test';

/** 连哪个后端：默认演示后端；E2E_API=real 时连本机服务端 v1（127.0.0.1:8765，经 Vite 转发） */
export const API = process.env.E2E_API === 'real' ? 'real' : 'mock';
/** 每个测试第一次打开页面时带上 ?api=，前端会记住这个选择 */
export const first = (path: string) => `${path}${path.includes('?') ? '&' : '?'}api=${API}`;

export async function enterAsGuest(page: Page) {
  await page.goto(first('/welcome'));
  await page.getByRole('button', { name: '先看看示例' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '今天' })).toBeVisible();
}

/** 手机号登录：点“获取验证码”，读页面上的开发环境验证码填入（演示后端固定 123456，服务端 sms=dev 时随机） */
export async function login(page: Page, phone: string) {
  await page.goto(first('/login'));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByRole('checkbox').click();
  await page.getByRole('button', { name: '获取验证码' }).click();
  const hint = page.getByText(/开发环境验证码：\d{6}/);
  await expect(hint).toBeVisible();
  const code = /\d{6}/.exec((await hint.textContent()) ?? '')?.[0];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel('验证码').fill(code!);
}

export async function loginDemo(page: Page) {
  if (API === 'real') {
    const session = process.env.FULLGRID_E2E_DEMO_SESSION;
    if (!session) throw new Error('真实端到端测试的演示会话没有初始化');
    const { origin, value } = JSON.parse(session) as { origin: string; value: string };
    await page.context().setStorageState({
      cookies: [],
      origins: [{
        origin,
        localStorage: [{ name: 'fullgrid.session', value }],
      }],
    });
    await page.goto(first('/'));
  } else {
    await login(page, '13800000000');
  }
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('link', { name: /高等数学，还有 3 天考试/ })).toBeVisible();
}

/** 作答当前题：选择题点第一项，其余题型填一个答案；等到出结果（对错或自评）。 */
export async function answerCurrent(page: Page) {
  const submit = page.getByRole('button', { name: '提交' });
  await expect(submit).toBeVisible();
  const option = page.getByRole('radio');
  if (await option.count()) await option.first().click();
  else await page.getByRole('textbox', { name: '你的答案' }).fill('11');
  await submit.click();
  await expect(page.getByText(/答对了|答错了|部分正确|对照评分点自评/).first()).toBeVisible();
}

/** 生成 n 页的最小 PDF（英文文字层），演示后端和服务端都能数出页数、读出文字 */
export function pdf(pages: number): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < pages; i += 1) {
    const text = `BT /F1 16 Tf 72 720 Td (Review notes, page ${i + 1}: process scheduling, deadlock avoidance, paging.) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
