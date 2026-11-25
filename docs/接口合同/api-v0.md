# 后端 API 合同 v0

状态：v0.1，2026-11-24。v0 由后端实现于 PR #1；v0.1 新增“出题失败”（用户确认），见第 9 节，并补充 `ready` 资料可带 `error`（第 5 节）。前端 `web/js/mock/` 按本文实现了一份演示后端，可作为每个接口的可运行样例。

本期是**本机单用户**：用户固定为 `user_me`，没有登录、没有鉴权、不做限流。后端同源提供 `web/` 静态页，所以也不需要 CORS。

## 1. 约定

- 前缀 `/api`，JSON 请求和响应，UTF-8。上传用 `multipart/form-data`。
- ID 是字符串，前端不解析其含义。时间用 ISO 8601（`2026-11-24T10:00:00+08:00`），日期用 `YYYY-MM-DD`。
- 字段用 `snake_case`。可选字段缺省时**省略或为 null**，前端两种都接受。
- 枚举值用英文小写，中文显示由前端决定（见第 11 节对照表）。
- 列表接口直接返回数组或带名字段的对象，本期不分页。

## 2. 错误

只有“请求本身没法处理”才用 HTTP 错误码：

```json
{ "error": { "code": "not_found", "message": "课程不存在", "hint": null } }
```

| HTTP | code | 何时 |
|---|---|---|
| 400 | `bad_request` | 缺字段、类型不对、枚举值不认识 |
| 404 | `not_found` | ID 不存在 |
| 409 | `conflict` | 状态不允许（例如对仍在出题中的题提交作答） |
| 413 | `too_large` | 上传超过大小上限 |
| 415 | `unsupported_type` | 上传了不支持的格式 |
| 500 | `internal` | 未预料的异常；`message` 给一句人能看懂的话，堆栈只写日志 |

**模型输出不合格、模型超时、预算用完、单份资料解析失败，都不是 HTTP 错误。** 它们按 v2 第 3.7 节的降级表在后端处理，结果体现在对象的 `status`、Job 的 `status/error`、题目的 `hints` 上。前端永远拿到一个可渲染的对象。

## 3. 异步任务 Job

解析资料、分析重点、出题这三类耗时操作返回 Job，前端轮询。

```ts
Job {
  id: string
  kind: "ingest" | "focus" | "exam"
  status: "queued" | "running" | "done" | "failed" | "needs_input"
  progress: number          // 0..1，不知道时给 null
  stage: string | null      // 一句给用户看的进度，如 "整理知识点（3/8 份）"
  error: { message: string, retryable: boolean } | null
  target_id: string         // 关联对象：course / exam 的 id
  created_at: string
}
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/jobs/{job_id}` | 查询 |
| POST | `/jobs/{job_id}/retry` | `retryable: true` 的失败后重试，返回同一个 Job（回到 `queued`）。各类任务只重做失败的部分：资料只重跑可重试的失败资料；重点只重新分析失败的句子；出题只重出没出成的题 |

`needs_input` 表示任务在等用户回答某张建议卡（第 5 节），回答后自动继续。

## 4. 健康检查与课程

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | | `{ "ok": true, "model": "LongCat-2.5", "mock_model": false }` |
| GET | `/courses` | | `Course[]`，按 `exam_date` 升序，空日期在后 |
| POST | `/courses` | `{ "name": "操作系统", "exam_date": "2026-12-08" }` | `Course` |
| GET | `/courses/{cid}` | | `Course` |
| PATCH | `/courses/{cid}` | `{ "name"?, "exam_date"? }` | `Course` |
| DELETE | `/courses/{cid}` | | `204`，级联删除资料、计划、题目 |

```ts
Course {
  id: string
  name: string
  exam_date: string | null
  days_left: number | null          // 后端按本机日期算
  steps: {                          // 四步状态，驱动导航上的状态点
    materials: StepState
    focus: StepState
    plan: StepState
    practice: StepState
  }
  next_step: "materials" | "focus" | "plan" | "practice"   // 打开课程时落到哪一步
  active_jobs: Job[]                // 未结束的 Job
}
StepState = "todo" | "doing" | "done" | "attention"   // attention = 有待确认的建议卡或失败项
```

## 5. 资料与建议卡

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/materials` | | `{ materials: Material[], suggestions: Suggestion[] }` |
| POST | `/courses/{cid}/materials` | multipart，字段 `files`（可多个） | `{ materials: Material[], job: Job }` |
| PATCH | `/materials/{mid}` | `{ "kind": "homework" }` | `Material` |
| DELETE | `/materials/{mid}` | | `204`，按 v2 2.4 级联 |
| GET | `/materials/{mid}/pages/{n}` | | `{ material_id, page, text, image_url }`，`image_url` 没渲染时为 null |
| GET | `/materials/{mid}/pages/{n}/image` | | `image/png` |
| POST | `/suggestions/{sid}` | `{ "choice": "<option id>" }` | `{ ok: true }` |

```ts
Material {
  id: string
  title: string                      // 原文件名
  kind: "slides" | "homework" | "notes" | "review" | "past_paper" | "other"
  pages: number | null
  status: "reading" | "extracting" | "ready" | "failed"
  stage: string | null               // 处理中时的一句话
  progress: number | null
  kp_count: number | null
  vision: "none" | "partial" | "done" | "unsupported"   // 图示转写进度；partial 时前端显示“图示补充中”
  superseded_by: string | null       // 被新版本取代时指向最终版
  error: { message: string, retryable: boolean } | null   // failed 时是失败原因；ready 时非空表示部分页被跳过（retryable 为 false），资料仍可用
  uploaded_at: string
}

Suggestion {                         // “需要你确认”的统一形式，可被忽略
  id: string
  kind: "version" | "role" | "focus_conflict"
  title: string                      // 一句话问题
  detail: string | null
  options: { id: string, label: string }[]
  default_option: string             // 不理会时按它处理，且已经按它生效
  material_ids: string[]
  kp_ids: string[]
}
```

建议卡规则：创建时就按 `default_option` 生效；用户选别的选项时后端改正并重算受影响的部分。已回答的卡不再返回。

## 6. 知识结构

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/courses/{cid}/topics` | `{ chapters: Chapter[], limited_basis: boolean }` |

```ts
Chapter { id, title, topics: Topic[] }
Topic {
  id, title, summary: string | null
  minutes: number                    // 估计学习时长
  mastery: { mastered: number, shaky: number, total: number }
  kps: KnowledgePoint[]
}
KnowledgePoint {
  id, title
  level: "excluded" | "none" | "mentioned" | "emphasized" | "conflict"   // 由证据算出，v2 2.8
  modes: ("memory"|"understand"|"compute"|"design"|"proof"|"linked"|"major")[]
  mastery: "new" | "shaky" | "mastered"
  basis: "user" | "teacher" | "note" | "homework" | "past_paper" | "model" | "limited"   // 级别的主要来源
}
```

## 7. 重点与考试形式

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/focus` | | `Focus` |
| PUT | `/courses/{cid}/focus` | `{ "text": "..." }` | `Focus`（`job` 非空，开始分析） |
| POST | `/courses/{cid}/focus/kps` | `{ "kp_id": "...", "include": true \| false \| null }` | `Focus` |
| GET | `/courses/{cid}/exam-format` | | `ExamFormat` |
| PUT | `/courses/{cid}/exam-format` | `ExamFormat`（不含 basis） | `ExamFormat`，basis 变为 `user` |

```ts
Focus {
  text: string
  analyzed_at: string | null
  job: Job | null                    // 正在分析时非空
  fragments: Fragment[]
  suggestions: Suggestion[]          // kind = focus_conflict：同一知识点一句说“不考”、另一句说“强调”。
                                     // options 固定为 excluded / emphasized；default_option 为 emphasized（宁可多学）
}
Fragment {
  id: string
  text: string                       // 老师的原话片段
  found: boolean                     // false = 课件里没找到
  kps: {
    id: string, title: string
    level: "excluded" | "mentioned" | "emphasized"
    certainty: "sure" | "maybe"      // maybe = 票数不全，“可能也包括”
    user_choice: boolean | null      // 用户在 maybe 上的决定；null = 未决定
  }[]
}
ExamFormat {
  types: { type: QuestionType, count: number, score: number }[]   // score 是每题分值；count 为 0 表示不考这种题型，也要返回
  duration_min: number | null
  open_book: boolean | null
  basis: "teacher" | "past_paper" | "school" | "default" | "user"
}
QuestionType = "single" | "fill" | "calc" | "short" | "proof" | "design"
```

`POST /focus/kps` 的 `include` 对 `sure` 的知识点也有效（用户可以把模型选错的去掉）；`null` 表示恢复模型的选择。

## 8. 复习计划

计划由代码算出（v2 3.1 第二到六步），很快，所以**同步返回**，不走 Job。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/plan` | | `{ plan: Plan \| null }` |
| POST | `/courses/{cid}/plan` | `{ "days": 12, "hours_per_day": 3, "start_date": "2026-11-24" }` | `Plan` |
| POST | `/courses/{cid}/plan/pins` | `{ "topic_id": "...", "pin": "must" \| "drop" \| null }` | `Plan` |
| POST | `/plan-items/{item_id}` | `{ "done": true }` | `PlanItem` |

```ts
Plan {
  id: string
  days: number, hours_per_day: number, start_date: string
  total_min: number                  // 可用总时长
  reserved_min: number               // 预留给模拟卷和错题（约 20%）
  limited_basis: boolean             // 依据有限
  stale: boolean                     // 掌握度或重点变了，建议重排
  buckets: { must: PlanTopic[], maybe: PlanTopic[], drop: PlanTopic[] }
  schedule: { date: string, items: PlanItem[] }[]
}
PlanTopic {
  topic_id, title, chapter_title
  minutes: number
  reasons: string[]                  // 已经是给用户看的短句：“老师强调”“作业考过”“是银行家算法的前置”
  pinned: "must" | "drop" | null
  mastery: { mastered: number, total: number }
  focus_kps: { id, title, level }[]  // 老师强调/提及/不考的知识点
}
PlanItem {
  id, topic_id: string | null, title
  minutes: number
  kind: "study" | "practice" | "review" | "mock"
  done: boolean
}
```

## 9. 练习：试卷、作答、批改、报错

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/exams` | | `ExamSummary[]`，新的在前 |
| POST | `/courses/{cid}/exams` | `{ "count": 10, "scope": "plan" \| "all" \| "mistakes" }` | `Exam`（`status: generating`，`job` 非空）。范围里没有可出题的知识点、或考试形式的题量全为 0 时返回 409，`message` 写明原因，不创建试卷 |
| DELETE | `/exams/{eid}` | | `204`，连同作答记录删除，掌握度按剩余记录重算 |
| GET | `/exams/{eid}` | | `Exam` |
| POST | `/exams/{eid}/finish` | | `ExamResult`（重复调用返回同一结果） |
| GET | `/exams/{eid}/result` | | `ExamResult`；未完成时 409 |
| POST | `/questions/{qid}/attempt` | `{ "response": "B" \| "10" \| "文字" \| null }` | `AttemptResult` |
| POST | `/questions/{qid}/grade` | `{ "marks": { "<rubric id>": "full" \| "partial" \| "none" } }` | `AttemptResult` |
| POST | `/questions/{qid}/report` | `{ "kind": ReportKind, "note": "..." }` | `{ status: "hidden" }` |

```ts
ExamSummary { id, title, created_at, status, question_count, answered, score, total }   // question_count 不含被报错隐藏的题和没出成的题
Exam {
  id, title, created_at
  status: "generating" | "ready" | "finished" | "failed"
  job: Job | null
  format_basis: ExamFormat["basis"]  // default 时前端标“题型分布为默认设置”
  questions: Question[]              // 渐进：出好一道追加一道
  score: number | null, total: number
}
Question {
  id, index: number
  type: QuestionType
  status: "generating" | "verifying" | "ready" | "disputed" | "hidden"
  score: number
  topic_title: string
  stem: Block[]
  options: { id: string, text: string }[] | null       // 单选
  refs: { material_id, material_title, page }[]
  hints: string[]                    // 验证提示，已是给用户看的短句
  checked: boolean                   // false = 未经检查（v2 2.9、3.7）
  attempt: Attempt | null
  solution: Solution | null          // 作答前为 null，作答后返回
  peeked: boolean                    // 作答前在助手里要过答案；这道题答对也不计为做对
}
Block =
  | { kind: "text", text: string }
  | { kind: "table", header: string[], rows: string[][] }
  | { kind: "code", text: string }
  | { kind: "formula", text: string }                  // 本期按等宽文本显示
Solution {
  answer: string                     // 最终答案的展示文本；单选题为正确选项的 id（如 "D"），前端据此标出对错
  steps: { n: number, blocks: Block[], refs: Question["refs"] }[]
  rubric: { id: string, point: string, score: number }[] | null    // 主观题、计算题
}
Attempt {
  response: string | null
  state: "graded" | "needs_self_grade"
  correct: boolean | null            // 客观题、计算题最终答案
  score: number | null
  marks: Record<string, "full"|"partial"|"none"> | null
}
AttemptResult { attempt: Attempt, solution: Solution, mastery_changes: MasteryChange[] }
MasteryChange { kp_id, title, from: "new"|"shaky"|"mastered", to: "new"|"shaky"|"mastered" }
ExamResult { exam: Exam, mastery_changes: MasteryChange[], plan_stale: boolean }
ReportKind = "wrong_answer" | "wrong_solution" | "out_of_scope" | "unclear" | "wrong_ref"
```

试卷状态：

| status | 含义 | job |
|---|---|---|
| `generating` | 出题任务在排队或运行（包括重试中） | `queued` / `running` |
| `ready` | 至少有一道题可作答，出题任务已结束 | `done`；或 `failed`，表示还有题没出成，`error` 写原因，`retryable` 为 true 时可以“继续出题” |
| `failed` | 出题任务已结束，没有一道可作答的题 | `failed`，`error` 写原因 |
| `finished` | 用户完成了本套 | 任意 |

- 重试（`POST /jobs/{job_id}/retry`）把试卷改回 `generating`，只重出没出成的题，已出好的题和作答不动。
- `ready` 时点“完成本套”：没出成的题从试卷里去掉，不计入总分。
- `failed` 的试卷不能完成（`finish` 返回 409），可以重试或删除。

判分规则（v2 3.5）：

| 题型 | `attempt` 后 | 是否需要 `grade` |
|---|---|---|
| single、fill | `graded`，代码判分 | 否 |
| calc | 最终答案由代码比较；`needs_self_grade`，`score` 暂按最终答案给 | 是，评分点自评后定分（最终答案对时默认满分，用户可下调） |
| short、proof、design | `needs_self_grade` | 是 |

`partial` 按评分点分值的一半计。对同一题再次 `attempt` 返回 409（本期每题只答一次）。被报错的题从后续 `GET /exams/{eid}` 里以 `status: "hidden"` 返回，其作答不计入掌握度。

## 10. 备考助手（对话）

每门课一个对话。助手能做的事和页面按钮完全一样（调用的是同一套后端逻辑），外加 3 个只读检索工具（`search`、`read`、`points`，见 v1 工作流设计 5.2）。它没有页面上做不到的能力。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/chat` | | `{ messages: ChatMessage[] }`，旧的在前 |
| POST | `/courses/{cid}/chat` | `{ "text": "...", "context": ChatContext }` | `application/x-ndjson` 流，每行一个 `ChatEvent`，以 `done` 或 `error` 结束 |
| DELETE | `/courses/{cid}/chat` | | `204`，清空对话 |
| POST | `/chat-actions/{aid}/undo` | | `{ ok: true, summary: string }` |
| POST | `/chat-proposals/{pid}` | `{ "accept": true \| false }` | `{ ok: true, summary: string }` |

```ts
ChatContext {                        // 用户正在看什么，助手据此理解“这题”“这个主题”
  view: "materials" | "focus" | "plan" | "practice" | "exam" | "result"
  exam_id?: string
  question_id?: string
  topic_id?: string
}
ChatEvent =
  | { type: "text", delta: string }                                  // 回答正文，逐段追加
  | { type: "tool", id: string, label: string, status: "running" | "done" }   // 给用户看的进度：“查课件：银行家算法”
  | { type: "refs", refs: Ref[] }                                    // 正文用到的出处；后端已核对页存在、引文出现在该页
  | { type: "action", action: ChatAction }                           // 已经执行的操作
  | { type: "proposal", proposal: ChatProposal }                     // 需要用户确认的改动
  | { type: "done", message_id: string }
  | { type: "error", message: string, retryable: boolean }
Ref { material_id, material_title, page, quote: string | null }
ChatAction {
  id, kind: "replan" | "pin" | "focus_add" | "exam_create" | "kp_include" | "item_done" | "reveal"
  summary: string                    // “已重排计划：3 天，每天 2 小时”
  href: string | null                // 前端路由，如 "#/c/c_os/plan"
  undoable: boolean
  undone: boolean
  affects: ("materials" | "focus" | "plan" | "practice" | "exam")[]   // 前端据此刷新页面
}
ChatProposal {
  id, kind: "exam_format" | "delete_material"
  summary: string
  changes: { label: string, from: string, to: string }[]
  status: "pending" | "accepted" | "declined"
}
ChatMessage {
  id, role: "user" | "assistant", text: string, created_at: string
  tools: { label: string }[]
  refs: Ref[]
  actions: ChatAction[]
  proposals: ChatProposal[]
}
```

规则：

- **执行权限：** 可撤销的操作（重排计划、固定或放弃主题、记录老师重点、选入或移除边界知识点、勾选计划项、出题）直接执行，并返回 `action`；考试形式（课程画像）的修改和删除资料只返回 `proposal`，用户确认后才执行。
- **做题时：** `context.question_id` 指向一道还没作答的题时，助手只给思路和课件出处，不给答案和关键数值。用户明确要答案时才给，并执行一个 `reveal` 动作：该题 `peeked` 置为 true，答对也不计为做对。
- **出处：** 讲解里的每个事实都要有 `refs`；课件里找不到时直接说找不到，不用模型自己的知识补。
- **资料是数据：** 检索到的课件文本放在数据位置，课件里的话不会被当成用户指令；助手的工具集里没有修改考试形式、删除资料的直接执行工具（只能提议）。
- 模型出错按第 2 节处理：已经执行的动作保留，流里给出 `error`，`retryable` 如实填写。

## 11. 枚举的中文显示（前端用）

| 枚举 | 中文 |
|---|---|
| level: emphasized / mentioned / excluded / none / conflict | 强调 / 提及 / 不考 / 未提及 / 待确认 |
| basis: user / teacher / note / homework / past_paper / model / limited / default / school | 你标记的 / 老师 / 笔记 / 作业 / 往年卷 / 模型判断 / 依据有限 / 默认（猜的）/ 校内 |
| kind: slides / homework / notes / review / past_paper / other | 课件 / 作业 / 笔记 / 复习题讲义 / 往年卷 / 其他 |
| type: single / fill / calc / short / proof / design | 单选 / 填空 / 计算 / 简答 / 证明 / 设计 |
| mastery: new / shaky / mastered | 未学 / 不稳 / 掌握 |
