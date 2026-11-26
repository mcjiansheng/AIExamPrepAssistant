// 端到端流程（10 第 9 节）：干净的浏览器上下文；默认连演示后端，E2E_API=real 时连服务端 v1。
import { expect, test } from '@playwright/test';
import { answerCurrent, enterAsGuest, login, loginDemo } from './helpers';

test('看示例 → 学一个知识点 → 快练 → 结果', async ({ page }) => {
  await enterAsGuest(page);
  await page.getByRole('button', { name: /^开始：/ }).first().click();
  await expect(page).toHaveURL(/\/kp\//);
  const before = page.url();
  await page.getByRole('button', { name: /懂了|下一个/ }).last().click();
  await expect.poll(() => page.url()).not.toBe(before);

  await page.goto('/practice');
  await page.getByRole('button', { name: /开始快练/ }).click();
  await expect(page).toHaveURL(/\/session\//);
  await answerCurrent(page);
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '完成' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '完成' }).click();
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByRole('heading', { name: '快练完成' })).toBeVisible();
});

test('登录演示账号：三门课、顺延提示、日程', async ({ page }) => {
  await loginDemo(page);
  await expect(page.getByText('昨天有 2 项没做完，已排进今天')).toBeVisible();
  await page.goto('/schedule');
  await expect(page.getByText(/高等数学考试/).first()).toBeVisible();
});

test('助手：今天只有 1 小时 → 改动卡 → 撤销', async ({ page }) => {
  await enterAsGuest(page);
  await page.getByRole('button', { name: '今天只有 1 小时' }).click();
  await expect(page.getByText('调整了今天的时间')).toBeVisible();
  await expect(page.getByText(/今天可用 1 小时/)).toBeVisible();
  await page.getByRole('button', { name: '撤销' }).first().click();
  await expect(page.getByText('这次改动已撤销')).toBeVisible();
  await expect(page.getByText(/今天可用 2 小时/)).toBeVisible();
});

test('新用户：登录 → 引导里跳过 → 新建课程 → 等待连接 AI', async ({ page }) => {
  // 每次用新号码：连真实服务端时数据会留下来
  await login(page, `139${String(Date.now()).slice(-8)}`);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.getByRole('button', { name: '新建课程' }).click();
  await expect(page).toHaveURL(/\/courses\/new/);
  await page.getByLabel('课程名').fill('数据结构');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('input[type=file]').first().setInputFiles({ name: '数据结构 第一章.pptx', mimeType: 'application/octet-stream', buffer: Buffer.from('demo') });
  await expect(page.getByText('数据结构 第一章.pptx')).toBeVisible();
  for (let i = 0; i < 4; i += 1) await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '进入课程' }).click();
  await expect(page.getByText('等待连接 AI 后整理').first()).toBeVisible();
});
