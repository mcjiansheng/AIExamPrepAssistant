# 后端 API 合同 v1

状态：v1.1，2026-11-26（PST）。v1 于 2026-11-25 确认合并；v1.1 的改动：

- 后台任务的用量确认（第 2、3、7、9、10 节）：整理资料预计超过确认阈值时任务暂停等确认，新增 `Job.estimate`、`POST /jobs/{id}/continue`，资料和课程增加 `waiting_confirm`；上传不再需要确认。
- 明确访客和示例课程用助手也需要连接（第 14 节）。

依据 `docs/设计/产品v1/08-工程与服务端.md` 第 3 节的大纲和 `09-核心流程细节.md` 的规则。`client/src/mock/` 按本文实现了一份浏览器内的演示后端，可作为每个接口的可运行样例；`client/src/api/types.ts` 与本文的类型一一对应。

v0（`api-v0.md`）在 v1 上线前继续可用；v1 的前端只调用 v1。

## 1. 约定

- 前缀 `/api/v1`。JSON 请求和响应，UTF-8；上传用 `multipart/form-data`。
- 认证：`Authorization: Bearer <access_token>`。除 `/health`、`/auth/*`、`/providers/presets` 外都要认证。事件流 `GET /events` 用查询参数 `?access_token=`（浏览器 EventSource 不能设请求头）。
- 每个资源都按 `user_id` 校验归属；不属于当前用户的 ID 一律 404。
- ID 是字符串，客户端不解析。时间用带时区的 ISO 8601（`2026-11-25T18:30:00-08:00`），日期用 `YYYY-MM-DD`。“今天”按用户的 `timezone`（IANA 名称，登录时由设备上报）计算。
- 字段 `snake_case`；可选字段缺省时为 `null`，客户端同时接受省略。枚举用英文小写，中文显示由客户端决定。
- 创建类的 `POST` 可以带 `Idempotency-Key` 请求头：同一用户同一键在 24 小时内重复提交，返回第一次的结果。客户端在“连接 AI 后自动重发”时依赖它。
- 列表不分页，除非接口写明 `?limit=`。

### 1.1 改动响应 `Change<T>`

会影响其他页面、或可以撤销的写操作，返回统一的外壳：

```ts
Change<T> {
  result: T
  affects: Area[]          // 客户端据此刷新这些区域
  undo: Undo | null        // 可撤销时非空
}
Undo { id: string, label: string, expires_at: string }   // label 是撤销条上的话：“已挪到明天”
Area = "today" | "schedule" | "courses" | "course" | "map" | "kp" | "materials" | "focus"
     | "practice" | "session" | "mistakes" | "insight" | "threads" | "settings" | "providers"
     | "plugins" | "notifications"
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/undo/{undo_id}` | | `{ ok: true, affects: Area[], summary: string }`；已撤销或已失效时 409 |

撤销在之后的改动碰到同一对象之前都有效，最长 24 小时（09 第 9 节）。

## 2. 错误

```json
{ "error": { "code": "ai_required", "message": "还没有连接 AI 模型", "hint": null, "detail": null } }
```

| HTTP | code | 何时 | 客户端 |
|---|---|---|---|
| 400 | `bad_request` | 缺字段、类型不对、枚举不认识 | 显示 message |
| 401 | `unauthorized` | 没有令牌或令牌过期 | 刷新令牌后重发一次 |
| 403 | `login_required` | 访客要保存自己的数据 | 弹登录层，登录后重发 |
| 403 | `forbidden` | 权限不够（插件未授权等） | 显示 message |
| 404 | `not_found` | ID 不存在或不属于当前用户 | |
| 409 | `conflict` | 状态不允许（重复作答、撤销已失效等） | 显示 message |
| 409 | `ai_required` | 需要 AI 但没有可用连接 | 弹连接 AI 层，连接后重发 |
| 409 | `needs_confirmation` | 同步请求（如出模拟卷）预计用量超过确认阈值；`detail.estimate` 为 `Estimate`。后台任务不用它，见第 3 节 | 显示估算，确认后带 `confirm: true` 重发 |
| 413 | `too_large` | 上传超过上限 | |
| 415 | `unsupported_type` | 不支持的文件格式 | |
| 429 | `rate_limited` | 短信、登录、对话限流；`detail.retry_after_sec` | 倒计时后可重试 |
| 500 | `internal` | 未预料的异常；message 是一句人能看懂的话，堆栈只写日志 | 原因 + 重试 |

**模型输出不合格、模型超时、限流、单份资料解析失败都不是 HTTP 错误**：按 v2 第 3.7 节在服务端降级，结果体现在对象的 `status`、Job 的 `status/error`、题目的 `check` 上。

## 3. 后台任务 Job

```ts
Job {
  id: string
  kind: "ingest" | "focus" | "session" | "agent" | "export"
  status: "queued" | "running" | "done" | "failed" | "needs_input"
  progress: number | null          // 0..1
  stage: string | null             // 给人看：“抽取知识点（3/8 份）”
  error: { message: string, retryable: boolean } | null
  course_id: string | null
  target_id: string                // material / course / session / message / user 的 id
  result: { url: string | null } | null   // export 完成后的下载地址
  estimate: Estimate | null        // status 为 needs_input 且在等用户确认用量时非空（第 7 节）
  created_at: string
}
```

`needs_input` 表示任务在等用户，已完成的部分保留：

- **确认用量**：预计用量超过确认阈值，`estimate` 非空，`stage` 为“等待确认用量”。暂停发生在第一次调用模型之前，不需要模型的步骤（读文件、数页数、文字识别）可以先做。
- **每日上限**：执行中到达每日上限，做完当前这一步后暂停，`estimate` 为 null，`stage` 为“已达今日上限”。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/jobs/{id}` | 查询 |
| POST | `/jobs/{id}/retry` | `retryable: true` 的失败后重试，只重做失败的部分（沿用 v0.1） |
| POST | `/jobs/{id}/continue` | `needs_input` 的任务继续，返回 `Job`：等确认用量的，这次调用即确认；到达每日上限的，提高上限后再调。任务不是 `needs_input`、或仍超每日上限时 409 `conflict` |

进度变化通过事件流推送（第 15 节），客户端不轮询。

## 4. 健康检查

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/health` | `{ ok: true, version: "1.0", capabilities: { ocr: boolean, speech: boolean }, sms: "dev" \| "live" }` |

`sms: "dev"` 时验证码打印在服务端日志里，并在 `POST /auth/sms` 的响应里返回 `dev_code`。

## 5. 认证与账号

```ts
DeviceInfo { kind: "phone" | "tablet" | "desktop" | "browser", name: string, timezone: string }
Tokens { access_token: string, refresh_token: string, expires_in: number, user: User, is_new: boolean }
User {
  id: string
  nickname: string
  avatar_url: string | null
  phone_masked: string | null      // "138****0000"；访客为 null
  guest: boolean
  school: string | null
  major: string | null
  timezone: string
  onboarding: { ai: "done" | "skipped" | null, course: "done" | "skipped" | null }
  deletion_at: string | null       // 注销冷静期结束时间
  created_at: string
}
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/auth/sms` | `{ phone }` | `{ cooldown_sec: 60, dev_code: string \| null }`；限流见 09 第 11 节 |
| POST | `/auth/login` | `{ phone, code, device: DeviceInfo }` | `Tokens`；新号码自动注册（`is_new: true`）；验证码错误 400，message 写剩余次数 |
| POST | `/auth/guest` | `{ device }` | `Tokens`（`user.guest: true`，只有示例课程） |
| POST | `/auth/huawei` | `{ auth_code, device }` | `Tokens`。本版服务端为假实现，接口形状按 05 第 2.1 节 |
| POST | `/auth/qr` | `{ device }` | `{ id, payload: string, expires_at }`；payload 编进二维码 |
| GET | `/auth/qr/{id}` | | `{ status: "waiting" \| "scanned" \| "confirmed" \| "expired", tokens: Tokens \| null }` |
| POST | `/auth/qr/{id}/scan` | （已登录的手机） | `{ device_name: string }`；电脑端状态变为 scanned |
| POST | `/auth/qr/{id}/confirm` | （已登录的手机） | `{ ok: true }`；电脑端下一次查询拿到 tokens |
| POST | `/auth/refresh` | `{ refresh_token }` | `Tokens` |
| POST | `/auth/logout` | | `204`，吊销本设备的刷新令牌 |
| GET | `/me` | | `User` |
| PATCH | `/me` | `{ nickname?, avatar_url?, school?, major?, timezone?, onboarding? }` | `User` |
| GET | `/me/stats` | | `{ week_minutes: number, streak_days: number }` |
| GET | `/me/devices` | | `Device[]` |
| DELETE | `/me/devices/{id}` | | `204`，该设备退出登录 |
| POST | `/me/export` | | `Job`（kind `export`，完成后 `result.url` 可下载 zip） |
| DELETE | `/me` | | `{ deletion_at }`：进入 7 天冷静期 |
| POST | `/me/restore` | | `User`：冷静期内撤销注销 |
| PUT | `/me/resume` | `ResumeInput` | `204`：上报学习位置 |
| POST | `/feedback` | `{ kind: "bug" \| "idea" \| "report", text, context: string \| null }` | `204` |

```ts
Device { id, kind: DeviceInfo["kind"], name: string, last_seen: string, current: boolean }
ResumeInput { kind: "kp" | "session", course_id: string, kp_id?: string, session_id?: string, position?: number }
```

## 6. 设置、提醒、记忆

```ts
Settings {
  daily_minutes: number                       // 30..600，默认 120
  intensity: "easy" | "standard" | "sprint"
  theme: "system" | "light" | "dark"
  reduce_motion: "system" | "on" | "off"
  briefing: boolean                           // 每日简报
  proactive_hints: boolean                    // 卡住时主动提示
  memory: boolean                             // 助手记忆
}
Reminders { daily: { enabled: boolean, time: string /* "20:00" */ }, exam_soon: boolean, jobs: boolean }
MemoryItem { id, text: string, source: "user" | "practice", created_at: string }
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/me/settings` | | `Settings` |
| PATCH | `/me/settings` | `Partial<Settings>` | `Change<Settings>`；改 `daily_minutes`、`intensity` 时 affects 含 today、schedule |
| GET | `/me/reminders` | | `Reminders` |
| PUT | `/me/reminders` | `Reminders` | `Reminders` |
| GET | `/me/memory` | | `MemoryItem[]` |
| DELETE | `/me/memory/{id}` | | `204` |
| DELETE | `/me/memory` | | `204`，清空 |

## 7. 模型连接、角色与用量

```ts
Preset {
  id: string, name: string, tagline: string
  price_tier: 1 | 2 | 3                       // 大致价格档位
  protocol: "openai" | "longcat" | "anthropic"
  base_url: string
  key_url: string                             // 服务商控制台
  key_steps: string[]                         // “怎么获取密钥”的三步
  models: PresetModel[]
  default_model: string
}
PresetModel { id: string, name: string, vision: boolean, context_k: number, price: { input: number, output: number } | null }  // 元 / 百万 token
Connection {
  id: string, preset_id: string | null, name: string
  protocol: Preset["protocol"], base_url: string
  key_last4: string                           // 密钥只进不出
  status: "unchecked" | "ok" | "invalid" | "limited"
  status_message: string | null               // 服务商返回的原因，已转成人话
  checked_at: string | null
  capabilities: Capabilities | null
  models: string[]
}
Capabilities { chat: boolean, json: boolean, tools: boolean, vision: boolean, stream: boolean, context_k: number | null }
CheckStep { id: "connect" | "models" | "json" | "tools" | "vision", ok: boolean, message: string | null }
Role = "chat" | "organize" | "generate" | "vision"
Models {
  roles: Record<Role, { connection_id: string, model: string } | null>
  ocr: "builtin" | { connection_id: string, model: string }
  speech: "disabled" | "builtin" | { connection_id: string, model: string }
}
Estimate { tokens_min: number, tokens_max: number, cost_min: number | null, cost_max: number | null, needs_confirm: boolean }
Tally { tokens_in: number, tokens_out: number, cost: number | null }
Usage {
  period: "week" | "month", from: string, to: string
  total: Tally
  by_feature: (Tally & { feature: "chat" | "organize" | "generate" | "verify" | "vision" | "plugin" })[]
  by_course: (Tally & { course_id: string, name: string })[]
  by_plugin: (Tally & { plugin_id: string, name: string })[]
  daily: { date: string, tokens: number }[]
  recent: { id: string, label: string, course_name: string | null, tokens: number, cost: number | null, created_at: string }[]
}
Limits { confirm_tokens: number, daily_tokens: number | null, today_tokens: number }
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/providers/presets` | | `Preset[]`，按名称排序 |
| GET | `/me/providers` | | `Connection[]` |
| POST | `/me/providers` | `{ preset_id, key }` 或 `{ name, protocol: "openai", base_url, key, model? }` | `Connection`（`unchecked`） |
| PATCH | `/me/providers/{id}` | `{ key?, name?, base_url? }` | `Connection`；换密钥后回到 `unchecked` |
| DELETE | `/me/providers/{id}` | | `204`，立即失效 |
| POST | `/me/providers/{id}/check` | | `{ connection: Connection, steps: CheckStep[] }`；按 09 第 3 节的顺序，前两项失败时后面不跑 |
| GET | `/me/models` | | `Models` |
| PUT | `/me/models` | `{ roles?: Partial<Models["roles"]> }` | `Models` |
| GET | `/me/usage` | `?period=week\|month` | `Usage` |
| GET | `/me/limits` | | `Limits` |
| PUT | `/me/limits` | `{ confirm_tokens?, daily_tokens? }` | `Limits` |
| POST | `/estimate` | `{ op: "ingest", course_id, material_ids }` 或 `{ op: "session", kind, course_id, count }` | `Estimate` |

- `Estimate.needs_confirm`：估算中值（`tokens_min` 与 `tokens_max` 的平均）超过 `Limits.confirm_tokens`。
- 第一次连接成功且 `roles` 全空时，服务端把四个角色都指向这个连接的默认模型（能看图时 `vision` 也指向它）。
- 密钥用信封加密存储，任何接口都不返回明文（04 第 6 节）。

## 8. 今天与日程

```ts
Task {
  id: string, course_id: string, date: string
  kind: "learn" | "practice" | "review" | "mock" | "mistakes"
  title: string                    // “银行家算法”“操作系统快练 5 题”
  minutes: number
  status: "todo" | "done" | "skipped"
  reason: string                   // “老师强调 · 还没学”
  moved_from: string | null        // 顺延自哪天
  pinned: boolean
  kp_ids: string[]                 // learn 任务的知识点，按学习顺序
  session_id: string | null        // 已开始的练习
  progress: { done: number, total: number } | null
}
Countdown { course_id: string, name: string, color: number, exam_date: string, days_left: number, urgent: boolean }  // urgent = 离考试 ≤ 3 天
Resume { kind: "kp" | "session", course_id: string, title: string, detail: string | null, href: string, updated_at: string, device: string | null }
Today {
  date: string
  briefing: string | null          // 每日简报；设置关闭时为 null
  minutes_available: number
  minutes_planned: number
  progress: { done: number, total: number }
  countdowns: Countdown[]          // 离考试最近的在前
  resume: Resume | null
  tasks: Task[]                    // todo，按顺序
  done: Task[]                     // done 和 skipped
  notice: string | null            // “昨天有 2 项没做完，已排进今天”，当天只返回一次
  tomorrow: Task[]                 // 今天全部完成时用于预览
}
ScheduleDay { date: string, minutes_available: number, minutes_planned: number, tasks: Task[], exams: { course_id: string, name: string, color: number }[] }
Schedule { from: string, to: string, daily_minutes: number, intensity: Settings["intensity"], days: ScheduleDay[] }
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/today` | | `Today`；每天第一次请求时按 09 第 5.1 节生成 |
| PATCH | `/today` | `{ minutes }` | `Change<Today>`：今天的临时可用时间，重排今天未开始的任务 |
| PATCH | `/tasks/{id}` | `{ status?, date?, pinned? }` | `Change<Task>`；改 `date` 时自动 `pinned: true`；可撤销 |
| GET | `/schedule` | `?from=&to=`（默认今天起 7 天，最多 31 天） | `Schedule` |
| PATCH | `/schedule/days/{date}` | `{ minutes }` | `Change<ScheduleDay>` |
| POST | `/schedule/rebuild` | | `Change<Schedule>`：保留 pinned 的任务 |

## 9. 课程与知识点

```ts
Course {
  id: string, name: string
  color: number                    // 0..7，对应 07 第 2.3 节的课程色
  exam_date: string | null
  days_left: number | null
  sample: boolean                  // 示例课程
  readiness: { mastered: number, total: number }   // 09 第 8.1 节
  organizing: Organizing
  counts: { kps: number, materials: number, fragments: number, mistakes: number }
  daily_cap_min: number | null     // null = 自动分配
  created_at: string
}
Organizing {
  state: "idle" | "working" | "waiting_ai" | "waiting_confirm" | "attention"   // waiting_confirm 时 job_id 指向等确认的整理任务
  progress: number | null
  stage: string | null
  job_id: string | null
  attention: string | null         // “2 份资料要看”
}
KpState = "new" | "learned" | "shaky" | "mastered"
Level = "emphasized" | "conflict" | "mentioned" | "none" | "excluded"
Mode = "memory" | "understand" | "compute" | "design" | "proof" | "linked" | "major"
MapCell { id: string, title: string, state: KpState, level: Level, topic_id: string }
MapChapter { id: string, title: string, mastered: number, total: number, kps: MapCell[] }
CourseMap { course_id: string, chapters: MapChapter[] }
KpBrief { id: string, course_id: string, title: string, state: KpState, level: Level, chapter_title: string }
CourseHome { course: Course, map: CourseMap, next: Task[], weak: KpBrief[], last_session: SessionSummary | null }
Ref { material_id: string, material_title: string, page: number, quote: string | null }
Block =
  | { kind: "text", text: string }                         // 可含 **加粗**
  | { kind: "list", ordered: boolean, items: string[] }
  | { kind: "table", header: string[], rows: string[][] }
  | { kind: "code", text: string, lang: string | null }
  | { kind: "formula", text: string }                      // LaTeX 源；没有渲染插件时按等宽文本显示
  | { kind: "image", url: string, alt: string }
KpDetail {
  id: string, course_id: string, title: string
  chapter: { id: string, title: string }
  topic: { id: string, title: string }
  state: KpState, level: Level
  modes: Mode[]
  types: QuestionType[]            // 可能的题型
  teacher: { text: string, fragment_id: string }[]   // 老师原话
  sections: { blocks: Block[], refs: Ref[] }[]       // 讲解，分段带出处
  pages: Ref[]                     // 相关的课件原页
  quiz: Question[]                 // 小测 2–3 题（属于一个 kind=kp 的练习）
  map: MapChapter                  // 本章地图，页头小地图用
  prev_id: string | null, next_id: string | null
  task: { id: string, index: number, total: number } | null   // 从任务进来时
  understood_at: string | null
}
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses` | | `Course[]`，按考试日期升序，没有日期的在后 |
| POST | `/courses` | `{ name, exam_date?, color? }` | `Course`；同时建好本课的对话线程 |
| GET | `/courses/{cid}` | | `Course` |
| PATCH | `/courses/{cid}` | `{ name?, exam_date?, color?, daily_cap_min? }` | `Change<Course>` |
| DELETE | `/courses/{cid}` | | `204`，级联删除资料、知识点、练习、线程 |
| GET | `/courses/{cid}/home` | | `CourseHome` |
| GET | `/courses/{cid}/map` | | `CourseMap` |
| GET | `/kps/{kid}` | `?task_id=` | `KpDetail` |
| POST | `/kps/{kid}/understood` | `{ task_id? }` | `Change<{ kp: KpBrief, next_kp_id: string \| null, task: Task \| null }>` |
| POST | `/kps/{kid}/mark` | `{ mark: "shaky" \| "mastered" \| null }` | `Change<KpBrief>`：用户标记“还不熟”“已掌握”（09 第 8.1 节） |

## 10. 资料

```ts
MaterialKind = "slides" | "homework" | "notes" | "review" | "past_paper" | "photo" | "other"
Material {
  id: string, course_id: string, title: string
  kind: MaterialKind
  source: "file" | "photo"
  pages: number | null
  status: "waiting_ai" | "waiting_confirm" | "reading" | "extracting" | "ready" | "failed"
  stage: string | null, progress: number | null
  kp_count: number | null, question_count: number
  vision: "none" | "partial" | "done" | "unsupported"
  superseded_by: string | null
  decision: { kind: "version" | "role", text: string, options: { id: string, label: string }[], choice: string } | null
  skipped_pages: number[]          // ready 但部分页没读出来
  error: { message: string, retryable: boolean } | null
  uploaded_at: string
}
Page { material_id: string, material_title: string, page: number, total: number, text: string, image_url: string | null, kps: KpBrief[] }
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/materials` | | `Material[]`，新的在前 |
| POST | `/courses/{cid}/materials` | multipart：`files`（可多个）、`source`（`file` / `photo`） | `{ materials: Material[], job: Job \| null }`；没有连接 AI 时资料为 `waiting_ai`、`job` 为 null；预计用量超过确认阈值时 `job.status` 为 `needs_input`、资料为 `waiting_confirm` |
| PATCH | `/materials/{mid}` | `{ kind }` | `Change<Material>` |
| POST | `/materials/{mid}/decision` | `{ choice }` | `Change<Material>`：改自动判断的结果，重算受影响部分 |
| DELETE | `/materials/{mid}` | | `204`，按 v2 第 2.4 节级联 |
| GET | `/materials/{mid}/pages` | | `{ pages: { page: number, title: string \| null, thumb_url: string \| null }[] }` |
| GET | `/materials/{mid}/pages/{n}` | | `Page` |
| GET | `/materials/{mid}/pages/{n}/image` | | `image/png` |
| POST | `/courses/{cid}/photo-link` | | `{ url, expires_at }`：电脑上“用手机拍”的二维码内容 |

上传限制：类型和大小见 09 第 10 节，超出返回 413 / 415。

整理的用量确认（第 3 节）：上传本身不要求确认，也不返回 `needs_confirmation`，文件不用重传。上传时就能数出页数的格式（PDF、PPTX、DOCX、图片），响应里的 `job` 已经是 `needs_input`，客户端当场弹出估算；要读完才知道的，读完后、调用模型之前暂停，客户端在课程主页和资料页显示“开始整理”。连接 AI 后自动开始的整理按同样的规则。

## 11. 老师重点与考试形式

```ts
Fragment {
  id: string, text: string, found: boolean, created_at: string
  kps: {
    id: string, title: string
    level: "excluded" | "mentioned" | "emphasized"
    certainty: "sure" | "maybe"
    user_choice: boolean | null    // 用户的决定；null = 按模型
    included: boolean              // 当前是否算进重点（sure 默认 true，maybe 默认 false）
  }[]
}
Conflict { id: string, kp_id: string, title: string, text: string, choice: "excluded" | "emphasized" | null }   // 不选按 emphasized
Focus { course_id: string, fragments: Fragment[], conflicts: Conflict[], job: Job | null }
QuestionType = "single" | "fill" | "calc" | "short" | "proof" | "design"
ExamFormat {
  types: { type: QuestionType, count: number, score: number }[]   // 每种题型都返回，count 为 0 表示不考
  duration_min: number | null
  open_book: boolean | null
  basis: "teacher" | "past_paper" | "review" | "default" | "user"
}
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/courses/{cid}/focus` | | `Focus` |
| POST | `/courses/{cid}/focus/fragments` | `{ text, source?: "text" \| "photo" }` | `Focus`：按句切成片段，开始分析（`job` 非空） |
| DELETE | `/focus/fragments/{fid}` | | `Change<Focus>` |
| POST | `/courses/{cid}/focus/kps` | `{ kp_id, include: boolean \| null }` | `Change<Focus>` |
| POST | `/focus/conflicts/{id}` | `{ choice }` | `Change<Focus>` |
| GET | `/courses/{cid}/exam-format` | | `ExamFormat` |
| PUT | `/courses/{cid}/exam-format` | `ExamFormat`（不含 basis） | `Change<ExamFormat>`，basis 变为 `user` |

## 12. 练习与作答

```ts
SessionKind = "quick" | "kp" | "review" | "mistakes" | "mock"
SessionSummary {
  id: string, kind: SessionKind, course_id: string | null, course_name: string | null
  title: string                    // “操作系统 · 快练”
  status: Session["status"]
  created_at: string, finished_at: string | null
  question_count: number, answered: number
  score: number | null, total: number
}
Session {
  id: string, kind: SessionKind, course_id: string | null, title: string
  status: "preparing" | "active" | "finished" | "failed"
  created_at: string, started_at: string | null, finished_at: string | null
  time_limit_min: number | null    // 模拟卷
  position: number                 // 上次停在第几题（0 起）
  task_id: string | null
  job: Job | null                  // 出题任务
  questions: Question[]            // 渐进：出好一道追加或替换一道
  score: number | null, total: number
}
Question {
  id: string                       // 本次练习里的题（作答按它记）
  bank_id: string                  // 题库里的题；同一道题可出现在多次练习里
  index: number, version: number
  type: QuestionType
  status: "pending" | "ready" | "failed" | "hidden"
  check: "checking" | "passed" | "flagged" | "unchecked"
  check_note: string | null        // flagged 时的原因
  replaced: boolean                // 核对后换过题
  score: number
  kp: { id: string, title: string }
  course_id: string
  stem: Block[]
  options: { id: string, text: string }[] | null   // 单选
  refs: Ref[]
  hints: Hint[]                    // 已经给过的提示
  peeked: boolean                  // 看过完整解析
  attempt: Attempt | null
  solution: Solution | null        // 作答后或看完整解析后才有
}
Hint { level: 1 | 2 | 3, text: string, refs: Ref[] }
Solution { answer: string, steps: { n: number, blocks: Block[], refs: Ref[] }[], rubric: { id: string, point: string, score: number }[] | null }
Mark = "full" | "partial" | "none"
Attempt {
  response: string | null
  state: "graded" | "needs_self_grade"
  correct: boolean | null
  score: number | null
  marks: Record<string, Mark> | null
  answered_at: string
}
MasteryChange { kp_id: string, title: string, from: KpState, to: KpState }
AttemptResult { question: Question, mastery: MasteryChange[], mistake_added: boolean }
Result {
  session: Session
  score: number, total: number
  accuracy: number                 // 0..1，按题数
  duration_sec: number
  mastery: MasteryChange[]
  chapters: MapChapter[]           // 有变化的章节（变化后的状态）
  mistakes: Question[]
  review: { text: string, actions: ReviewAction[] } | null   // 助手复盘
  task: Task | null                // 因本次完成而勾掉的任务
}
ReviewAction { label: string, kind: "kp" | "session", kp_id: string | null, session: { kind: SessionKind, course_id: string, kp_id: string | null, count: number } | null }
PracticeHub {
  course_id: string | null
  quick: { count: number, minutes: number }
  review: { count: number, minutes: number }
  mistakes: { count: number }
  mock: { available: boolean, count: number, minutes: number, basis: ExamFormat["basis"] }
  history: SessionSummary[]
}
Mistake {
  question: Question               // 含 solution
  course_id: string, course_name: string
  reason: string                   // “选了 B”“自评：部分得分”
  wrong_count: number
  correct_streak: number           // 之后做对的次数，到 2 自动移出
  last_wrong_at: string
}
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/practice` | `?course_id=`（不带为全部课程） | `PracticeHub`；history 最近 20 条 |
| POST | `/sessions` | `{ kind, course_id?, kp_id?, question_ids?, count?, task_id?, confirm? }` | `Session`（`preparing`）；可能 409 `ai_required` / `needs_confirmation`；范围里没有可出题的知识点 409 `conflict` |
| GET | `/sessions/{sid}` | | `Session` |
| PATCH | `/sessions/{sid}` | `{ position }` | `204` |
| POST | `/sessions/{sid}/finish` | | `Result`（重复调用返回同一结果） |
| GET | `/sessions/{sid}/result` | | `Result`；未完成 409 |
| DELETE | `/sessions/{sid}` | | `204`，作答记录一起删，掌握度按剩余记录重算 |
| POST | `/questions/{qid}/attempt` | `{ response: string \| null }` | `AttemptResult`；已作答 409 |
| POST | `/questions/{qid}/grade` | `{ marks: Record<rubric id, Mark> }` | `AttemptResult` |
| POST | `/questions/{qid}/hint` | `{ level: 1 \| 2 \| 3 }` | `{ hint: Hint, question: Question }`；level 3 后 `peeked: true` 且带 solution |
| POST | `/questions/{qid}/report` | `{ kind: "wrong_answer" \| "wrong_solution" \| "out_of_scope" \| "unclear" \| "wrong_ref", note: string \| null }` | `{ question: Question }`（`hidden`） |
| GET | `/mistakes` | `?course_id=` | `Mistake[]` |
| DELETE | `/mistakes/{bank_id}` | | `Change<null>`：移出错题本，可撤销 |
| POST | `/mistakes/{bank_id}/similar` | | `Session`：同一知识点现出一道 |

- `kind: "mistakes"` 且带 `question_ids`（题库 id）时原题重做。
- 题目状态的变化（ready、换题、flagged）通过事件流推送 `question` 事件。
- 判分、提示、报错规则见 09 第 7 节；掌握度规则见 09 第 8 节。

## 13. 学情

```ts
Insight {
  course_id: string
  verdict: string                  // 一句结论：“按现在的速度，考前能掌握 8 成重点”
  readiness: { date: string, ratio: number }[]
  chapters: { id: string, title: string, new: number, learned: number, shaky: number, mastered: number }[]
  weak: KpBrief[]
  minutes: { total: number, learn: number, practice: number, review: number, mock: number }
}
```

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/courses/{cid}/insight` | `Insight` |

## 14. 助手

```ts
Thread { id: string, course_id: string | null, title: string, kind: "course" | "global" | "custom", model: string | null, updated_at: string, preview: string | null }
ChatContext { route: string, course_id?: string, kp_id?: string, session_id?: string, question_id?: string, material_id?: string, page?: number, selection?: string }
Command = "simplify" | "example" | "quiz" | "compare" | "outline" | "today" | "review"   // 插件命令为 "plugin:<id>:<name>"
Message {
  id: string, role: "user" | "assistant", text: string, created_at: string
  tools: { label: string }[]
  refs: Ref[]
  cards: Card[]
  memory: MemoryItem[]             // 本条回复记住的东西
  status: "done" | "error" | "stopped"
  error: { code: string, message: string } | null
}
ChatEvent =
  | { type: "start", message_id: string, user_message_id: string }
  | { type: "text", delta: string }
  | { type: "tool", id: string, label: string, status: "running" | "done" | "failed" }   // “查课件：银行家算法”
  | { type: "refs", refs: Ref[] }
  | { type: "card", card: Card }
  | { type: "memory", item: MemoryItem }
  | { type: "done" }
  | { type: "error", code: "ai_required" | "provider_error" | "tool_failed" | "internal", message: string, retryable: boolean }
CardBase { id: string, created_at: string }
Card = CardBase & (
  | { kind: "change", title: string, changes: { label: string, from: string, to: string }[], affects: Area[], undo_id: string | null, state: "applied" | "undone" | "expired", href: string | null }
  | { kind: "proposal", title: string, changes: { label: string, from: string, to: string }[], estimate: Estimate | null, affects: Area[], state: "pending" | "accepted" | "declined" }
  | { kind: "question", question: Question }
  | { kind: "practice", title: string, session_kind: SessionKind, course_id: string, kp_id: string | null, count: number, minutes: number, session_id: string | null }
  | { kind: "explain", title: string, kp_id: string | null, blocks: Block[], refs: Ref[] }
  | { kind: "map", course_id: string, chapter: MapChapter }
  | { kind: "schedule", title: string, days: { date: string, tasks: Task[] }[] }
  | { kind: "task", title: string, steps: { label: string, status: "pending" | "running" | "done" | "failed" | "stopped" }[], job_id: string | null, state: "running" | "done" | "stopped" | "failed", href: string | null }
  | { kind: "material", material: Material }
  | { kind: "usage", label: string, tokens: number, cost: number | null }
  | { kind: "connect", reason: string }
  | { kind: "plugin", plugin_id: string, template: TemplateNode }
)
TemplateNode = { type: "text" | "title" | "image" | "table" | "code" | "formula" | "list" | "progress" | "button" | "columns", props: Record<string, unknown>, children?: TemplateNode[] }   // 03 第 8.5 节
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/threads` | | `Thread[]`，最近的在前；全局线程总在 |
| POST | `/threads` | `{ course_id?, title? }` | `Thread`（kind `custom`） |
| PATCH | `/threads/{tid}` | `{ title?, model? }` | `Thread`；`model` 只影响本线程 |
| DELETE | `/threads/{tid}` | | `204`（只能删 custom） |
| GET | `/threads/{tid}` | `?limit=50` | `{ thread: Thread, messages: Message[] }`，旧的在前 |
| POST | `/threads/{tid}/messages` | `{ text, context: ChatContext, command?: Command, attachments?: string[] }` | `application/x-ndjson` 流，每行一个 `ChatEvent`，以 `done` 或 `error` 结束 |
| POST | `/threads/{tid}/stop` | | `204`，停止正在生成的回复（消息记为 `stopped`） |
| POST | `/proposals/{card_id}` | `{ accept: boolean }` | `{ card: Card, affects: Area[] }` |
| POST | `/agent-tasks/{job_id}/stop` | | `204` |

- 改动卡的撤销走 `POST /undo/{undo_id}`；撤销后卡片 `state` 变为 `undone`。
- 工具和权限分级见 03 第 3 节；做题时的提示与答案规则见 09 第 7.4 节；没有连接时流里第一条是 `card`（kind `connect`），随后 `done`。访客和示例课程也一样：示例课程的讲解和题目是静态数据，学习、练习不需要连接，助手需要。
- `attachments` 是先用 `POST /courses/{cid}/materials`（`source: photo`）上传得到的资料 id。

## 15. 事件流

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/events?access_token=` | `text/event-stream`，每个事件 `data:` 一行 JSON |

```ts
ServerEvent =
  | { type: "changed", areas: Area[], course_id: string | null }   // 其他设备或后台任务改了数据
  | { type: "job", job: Job }
  | { type: "question", session_id: string, question: Question }
  | { type: "notification", notification: Notification }
  | { type: "resume", resume: Resume }
```

断线后客户端用指数退避重连；重连成功后按 `changed`（全部区域）处理一次。

## 16. 通知与提醒

```ts
Notification {
  id: string
  kind: "job_done" | "job_failed" | "exam_soon" | "daily" | "device"
  title: string, body: string | null
  href: string | null              // 客户端路由
  created_at: string, read: boolean
}
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/notifications` | `?limit=50` | `{ items: Notification[], unread: number }` |
| POST | `/notifications/read` | `{ ids?: string[] }`（不带为全部） | `{ unread: number }` |

提醒设置见第 6 节 `Reminders`。

## 17. 插件

```ts
Plugin {
  id: string, name: string, version: string, description: string
  source: "builtin" | "file" | "url"
  installed: boolean, enabled: boolean
  scope: "all" | "courses", course_ids: string[]
  permissions: { read: string[], write: string[], network: string[], model: boolean }
  granted: boolean                 // 当前版本的权限已确认
  commands: { name: string, description: string }[]
  question_types: { id: string, name: string }[]
  cost: string                     // “不调用模型”
  usage_tokens: number             // 本月
}
```

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/plugins` | | `Plugin[]`：已安装 + 内置可用 |
| GET | `/plugins/{id}` | | `Plugin & { readme: string }` |
| POST | `/plugins` | multipart `file`（zip）或 `{ url }` | `Plugin`（`installed: false`，待确认权限） |
| POST | `/plugins/{id}/install` | | `Plugin`：确认权限并安装（`granted: true`） |
| PATCH | `/plugins/{id}` | `{ enabled?, scope?, course_ids? }` | `Plugin` |
| DELETE | `/plugins/{id}` | | `204`（内置插件只能停用） |

## 18. 识别

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/speech/transcribe` | 预留。本版 `capabilities.speech` 为 false，返回 409 `conflict` |

文字识别（OCR）不单独开放：上传照片、扫描版 PDF 时服务端自动运行（`capabilities.ocr`）。

## 19. 与 v0 的对应

| v0 | v1 |
|---|---|
| 固定用户 `user_me` | 第 5 节账号；所有资源加归属 |
| `Course.steps` / `next_step` | `Course.organizing` + `CourseHome.next`（课程主页不再分四步） |
| `GET /courses/{cid}/topics` | `GET /courses/{cid}/map`（地图）+ `GET /kps/{kid}` |
| `Suggestion`（建议卡） | 资料的 `decision` 一行结果；重点的 `conflicts` |
| 单课 `Plan` / `PlanItem` | 跨课程 `Today` / `Schedule` / `Task` |
| `Exam` / `ExamSummary` | `Session` / `SessionSummary`（kind `mock` 即模拟卷） |
| 题目先核对后给出 | 先出后核：`Question.check` |
| 轮询 Job | `GET /events` 推送 |
| `/courses/{cid}/chat` 单线程 | `/threads` 多线程 + 卡片 |
| `chat-actions/{id}/undo`、`chat-proposals/{id}` | `POST /undo/{id}`、`POST /proposals/{id}` |
| `local/api_key/` 读密钥 | `/me/providers`，密钥加密存数据库 |
