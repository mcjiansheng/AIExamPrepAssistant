# client/：满格 Web 前端

鸿蒙原生版的设计与实现蓝本（TypeScript + React + Vite）。设计依据：`docs/设计/产品v1/`（从 `00-总览.md` 读起；前端逻辑与交互准则见 `10-前端设计逻辑与交互准则.md`），接口依据：`docs/接口合同/api-v1.md`。

## 运行

```bash
cd client
npm install                 # 见下方“本机注意”
npm run dev                 # http://127.0.0.1:5173
```

- 找不到后端（`/api/v1/health` 不通）时自动用浏览器内的**演示后端**（`src/mock/`），数据存在 localStorage，`我的 → 数据` 里可以重置。
- 地址带 `?api=mock` / `?api=real` / `?api=auto` 可以强制切换（会记住）；`/api` 在开发时转发到 `127.0.0.1:8765`（服务端 v1 的默认端口）。
- 演示账号：手机号 `13800000000`，验证码 `123456`（三门课和两周的学习记录）；其他号码是新用户，走首次引导；“先看看示例”是访客，只有示例课程。

## 检查

| 命令 | 内容 |
|---|---|
| `npm run typecheck` | 生成 token 后 `tsc`（strict） |
| `npm test` | Vitest：演示后端按合同走主流程（`tests/unit/`） |
| `npm run build` | 生产构建 |
| `npm run e2e` | Playwright，用本机 Chrome（`channel: 'chrome'`，不下载浏览器）：`flows.spec.ts` 六条端到端流程（`E2E_API=real` 时连服务端 v1）；`screens.spec.ts` 在 390 / 768 / 1280 / 1600 四种宽度下给 15 个页面截图，存 `../local/证据/client-p0/` |
| `SAMPLES_DIR=<目录> npx vitest run tests/unit/samples.test.ts` | 从演示后端生成合同样例（`docs/接口合同/samples-v1/`） |
| `FIXTURES_DIR=<目录> npx vitest run tests/unit/fixtures.test.ts` | 导出示例课程、服务商预设、插件目录（服务端做示例数据用） |

## 目录

| 位置 | 内容 |
|---|---|
| `src/tokens/tokens.json` | 设计 token 唯一来源；`scripts/tokens.mjs` 生成 CSS 变量和鸿蒙 `resources` 的 color.json、float.json，弹簧曲线采样成 CSS `linear()` |
| `src/layout/` | 布局原语，名字和参数对齐 ArkUI：`Row`、`Column`、`Stack`、`Grid`、`Spacer`、`Divider`、`Scroll` |
| `src/ui/` | 展示组件，不取数据：按钮、输入、分组与列表、弹层与菜单、反馈状态、知识点地图、任务卡、题目、图表、页面骨架 |
| `src/features/` | 领域组件与 hooks：外壳、助手、连接 AI、登录、今天、课程、知识点、资料、重点、日程、练习、作答 |
| `src/pages/` | 路由入口，一页一个文件（对应 NavDestination） |
| `src/api/` | 合同类型（`types.ts`）、请求层与统一拦截（`client.ts`）、每个接口一个函数（`endpoints.ts`）、Query hooks（`hooks.ts`）、事件流（`events.ts`） |
| `src/mock/` | 演示后端：按合同实现全部接口，含示例课程内容、今日任务计算、先出后核、掌握度、规则版助手 |
| `src/state/` | 断点、登录状态、界面状态（zustand） |
| `src/strings/zh-CN.ts` | 全部界面文案 |
| `src/ui/icons.ts` | 图标语义名 ↔ lucide ↔ HM Symbol 对照表（HM Symbol 名为候选，转换时核对） |

## 写代码的规矩（为转 ArkUI）

见 `docs/设计/产品v1/08-工程与服务端.md` 第 1.3 节和 `10-前端设计逻辑与交互准则.md` 第 8 节，要点：

- 业务代码只用布局原语和 `ui/` 组件；间距只取 4 的倍数刻度（类型里限制了），颜色、字号只引用 token。
- 布局分支只看 `useBreakpoint()`（320 / 600 / 840 / 1440）；分栏另看内容区实际宽度（助手常驻时内容区会变窄）。
- 服务端数据只经 `api/hooks.ts`；写操作返回的 `affects` 决定刷新哪些页面，可撤销的操作显示撤销条。
- 文案从 `strings/` 取；一页一个主按钮；不写解释性副标题。

## 本机注意

- 仓库在 iCloud 同步的 `~/Documents` 下：装完依赖后执行 `xattr -w 'com.apple.fileprovider.ignore#P' 1 node_modules`，避免 node_modules 被同步和清出本机。
- 这台机器 PATH 上那份 npm 有文件被 iCloud 清出、不能用；可以用 DevEco Studio 自带的 npm：`node /Applications/DevEco-Studio.app/Contents/tools/node/lib/node_modules/npm/bin/npm-cli.js install`（Node 需 22.22 以上）。
