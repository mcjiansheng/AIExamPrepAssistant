// 四种尺寸下每个主页面一张截图，供设计评审（10 第 9 节）。截图存 local/证据/client-p0/（不进仓库）。
import { expect, test } from '@playwright/test';
import { answerCurrent, API, first, loginDemo } from './helpers';

const SIZES = [
  { name: 'sm-390', width: 390, height: 844 },
  { name: 'md-768', width: 768, height: 1024 },
  { name: 'lg-1280', width: 1280, height: 800 },
  { name: 'xl-1600', width: 1600, height: 1000 },
];
const OUT = `../local/证据/${API === 'real' ? 'server-v1' : 'client-p0'}`;

for (const size of SIZES) {
  test(`截图 ${size.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const shot = async (name: string) => {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/${size.name}-${name}.png`, fullPage: true });
    };
    await page.goto(first('/welcome'));
    await page.waitForTimeout(1300);
    await shot('01-welcome');
    await loginDemo(page);
    await shot('02-today');
    await page.goto('/courses');
    await expect(page.getByRole('heading', { name: '课程' })).toBeVisible();
    await shot('03-courses');
    const course = await page.getByRole('link', { name: /^操作系统，/ }).last().getAttribute('href');
    await page.goto(course!);
    await expect(page.getByText('准备度')).toBeVisible();
    await shot('04-course-home');
    await page.getByRole('button', { name: /银行家算法/ }).first().click();
    await expect(page.getByText('怎么考')).toBeVisible();
    await shot('05-kp');
    await page.goto(`${course}/materials`);
    await shot('06-materials');
    await page.goto(`${course}/focus`);
    await shot('07-focus');
    await page.goto(`${course}/insight`);
    await shot('08-insight');
    await page.goto('/schedule');
    await shot('09-schedule');
    await page.goto('/practice');
    await shot('10-practice');
    await page.getByRole('button', { name: /开始快练/ }).click();
    await expect(page.getByRole('button', { name: '提交' })).toBeVisible();
    await shot('11-session');
    await answerCurrent(page);
    await shot('12-session-answered');
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: '完成' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '完成' }).click();
    await expect(page).toHaveURL(/\/result$/);
    await shot('13-result');
    await page.goto('/me');
    await shot('14-me');
    await page.goto('/me/ai');
    await shot('15-ai');
  });
}
