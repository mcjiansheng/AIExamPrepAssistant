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
  await login(page, '13800000000');
  await expect(page).toHaveURL(/\/$/);
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
