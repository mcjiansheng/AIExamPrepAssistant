# 合同 v1 样例响应

由 `client/src/mock/`（浏览器内的演示后端）按 `api-v1.md` 生成，演示数据，不含真实课程内容。

- 文件名：`<方法>-<路径>.json`，路径里的 id 写成 `id`（`GET-courses-id-home.json` 即 `GET /courses/{cid}/home`）；`ERROR-<code>.json` 是错误外壳；对话流（NDJSON）存成事件数组。
- id、时间每次生成都会变；比对时看字段名、类型和枚举值，不比具体值。
- 重新生成：`cd client && SAMPLES_DIR=../docs/接口合同/samples-v1 npx vitest run tests/unit/samples.test.ts`
