# web/：WebUI 前端

原生 HTML/CSS + ES modules，没有框架、没有构建步骤、没有第三方依赖。设计见 `docs/设计/前端交互设计.md`，接口见 `docs/接口合同/api-v0.md`。

## 运行

```bash
cd web
python3 -m http.server 8811
```

浏览器打开 http://localhost:8811 。找不到后端时自动使用演示数据（顶栏显示“演示”），状态存在浏览器的 localStorage 里，侧栏底部可以“重置演示数据”。

后端写好后由后端同源提供本目录（`/` 返回 `index.html`，`/api/*` 是接口），前端会自动连上。也可以用 `?api=mock` 或 `?api=real` 强制指定。

## 目录

| 路径 | 内容 |
|---|---|
| `index.html` | 外壳 |
| `css/app.css` | 全部样式；颜色、字号等变量在文件开头 |
| `js/main.js` | 路由、外壳（侧栏 / 顶栏 / 底部标签）、轮询管理 |
| `js/api.js` | 接口客户端，与合同一一对应；后端探测 |
| `js/ui.js` | 转义模板 `html```、事件委托 `bind`、弹层、提示、格式化 |
| `js/labels.js` | 枚举的中文显示、荧光笔记号 |
| `js/assistant.js` | 备考助手面板：流式对话、动作卡片与撤销、提案确认 |
| `js/views/` | 每个页面一个文件：`home` `materials` `focus` `plan` `practice` `exam` `result`；`blocks.js` 渲染题目内容块 |
| `js/mock/` | 演示后端：`server.js` 按合同实现全部接口，`chat.js` 是关键词规则的演示助手，`data.js` 是演示内容（通用知识，不含课件原文） |

## 写页面的约定

- 视图导出 `mount(el, ctx)`。数据只从 `api` 取，不在前端计算重要度、计划、判分。
- 交互用 `data-act="名字"` + `bind(el, { 名字: fn })`；处理函数抛出的错误自动变成红色提示。
- 插值一律经过 `html```（自动转义）。布尔值渲染为 `true` 或空，可直接用于 `aria-pressed="${x}"`。
- 长任务用 `ctx.poll(fn)` 轮询，离开页面自动停止。
- 助手执行了操作会触发 `data-changed` 事件，外壳据此刷新当前页；作答页自己处理，不丢做题进度。页面可用 `setContext()` 告诉助手用户在看什么。
- 一页只有一个实心主按钮；说明最多一行；询问做成可忽略的建议卡（见设计文档第 3 节）。
