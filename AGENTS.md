# AGENTS.md · dsh-promote-on-timeout

> 面向要读/改这个插件的 agent。使用者自述在 `README.md`。只写占位符，不写本机绝对路径。

## 1. 30 秒看懂

一个**纯宿主半** DSH 插件（无客户端半、无路由、无座位）——**一个 `tools/execute` 包装器**：把 `pwsh`/`bash` 的前台调用接管成「先按后台语义启动进程 → 等窗口 → **到期才登记** `ctx.jobs` 任务并提升」。
它复刻的是 0.1.7 `@deepseek-ai/dsh-tool-pwsh` 的 `promoteOnTimeout`。

源码目录约定：`<工作区根>\plugins\<包名>`（本机所有自建插件同此）。

## 2. 文件

| 路径 | 是什么 |
|---|---|
| `lib/index.js` | **宿主半（真源码，单文件）**：唯一的实现 |
| `.smoke/wrapper-test.mjs` | **离线冒烟**（真源码 + 桩 ctx，83 断言）；不随包发布 |
| `package.json` | `type: module`、`main: lib/index.js`、`files: ["lib"]` |
| `README.md` / `AGENTS.md` | 自述 / 上手 |

## 3. 契约速查（改代码前先记住）

| 主题 | 约定 |
|---|---|
| 接管点 | `ctx.on("tools/execute", (exec, next) => …)`；**不调 `next()` = 整体接管**（waterfall 的 fallback 就是 `dispatchToolBody`）。pre-execute（允许/拒绝/询问、守卫）在其之前 |
| 交回本体的形态 | `run_in_background`、带 `sandbox_permissions`/`justification`、`command` 非法、`timeoutMs` 非法、无 `jobs` 服务 —— 一律 `next()` |
| 执行 | `ctx.shell.resolve(request)` → spec（默认 120000 / 上限 600000，来自执行器配置）；`ctx.shell.start(spec)` **无 deadline**（后台语义） |
| 登记**时机** | **窗口到期才登记**（延后登记）：窗口内结算的调用零注册表痕迹；`jobs.start()` 只出现在到期分支 |
| 登记 | 0.1.5 的 `JobStart` = `{ kind, label, owner: Agent, run(): { cancel, done, readOutput } }`；**owner 传 Agent 实例，不是 agent.id**（0.1.7 才是 id） |
| 等待 | `ctx.jobs.wait(id, ms, caller, signal)`：窗口内结算返回终态快照；仍在跑返回 `running`/`stopping` |
| 读取 | `ctx.jobs.read(id, caller)` → `{ text, snapshot }`，**单消费游标**；终态读会把任务标记 `reported`（完成通知因此不重复播报） |
| 返回形状 | 成功结果 = `{ isError: false, value, content }`，且 **`value` 必须过内置工具的输出 JSON Schema**：提升支用 `{ kind: "background", jobId }`，结算支用完整 foreground 值 |
| 依赖边界 | **不要 import `@deepseek-ai/*`**：profile 的 `node_modules` 里没有该 scope，装了也解析不到。渲染用的沙箱标记/措辞在源码注释里注明了出处，改成「逐字复刻」即可 |
| 渲染出处 | `renderProcessRead` ← `dsh-tool-pwsh@0.1.5-rc.3 lib/index.js:90`；标记段 ← 同文件 `:60`；`processOutcome` ← `:22`；提升措辞 ← `dsh-tool-pwsh@0.1.7-rc.2 lib/index.js:187` |

## 4. 改完必跑（离线，不碰任何工作区）

```powershell
cd <工作区根>\plugins\dsh-promote-on-timeout
node --check lib/index.js
node .smoke/wrapper-test.mjs      # 期望 ALL OK (83 assertions)
```

⚠️ **用 pwsh 直接跑**：不要在 node 里 `execFileSync(..., { stdio: "pipe" })`——沙箱下会 `EPERM`。
加到 83 之上的用例直接写在 `.smoke/wrapper-test.mjs` 的用例表里；新增行为**必须**补用例。

## 5. 红线

1. **`ctx.shell.start()` 成功之后绝不能再 `next()`**：进程已经跑起来了，回退只能自己处理（登记被拒时按 deadline 杀掉，与 0.1.7 同款降级）。`next()` 只允许出现在「还没启动任何东西」的分支里。
2. **不要**把 `exec.signal` 塞进 `spec`：那会让**提升后的任务**随调用一起被杀，语义退回「到点杀掉」。窗口内取消走 `proc.kill()`（此时还没有任务），提升之后走任务的 `cancel` 钩子。
3. **不要**发明新的 `value.kind`；`value` 过不了内置 schema 会把成功的调用变成失败。
4. **不要**改成全局注册同名工具去抢内置的注册：全局层重复名会抛（`duplicates within one layer … fail`）；作用域层影子注册是备选方案（见 `README.md` 的取舍说明）。

## 6. 实机验证清单（装完 + 重启实例后）—— 2026-09-29 已实测通过，数据见 `README.md` 的实机记录

1. `pwsh` 跑 `Start-Sleep -Seconds 200`，`timeoutMs` 传 `5000` → 约 5 秒后返回 `[still running after 5000ms; moved to background job pwsh-N]`；
2. `job_list` 看到该任务 `running`；`job_output <id>` 能读到 5 秒之后的新输出（**验证消费游标接续**）；
3. 等它自然结束 → 恰好**一条**完成通知；
4. 反例：`run_in_background: true`、带 `sandbox_permissions` 的调用与改动前逐字一致；
5. 把 `config.promoteOnTimeout` 置 `false` 重启 → 行为回到「到点杀掉」。
6. **延后登记复测**：窗口内结算的普通前台调用（`Write-Output 'x'`，`timeoutMs: 5000`）→ 任务表**不应出现任何新行**；超时那条 → 行在约 5 s 后才出现。

## 7. 安装 / 生效 / 卸载

- 安装：① `<home>/profiles/<profile>/node_modules/` 建符号链接指向本目录；② 该 profile 的 `cordis.patch.yml` 加 `- insert: [{ id: promote-on-timeout, name: dsh-promote-on-timeout }]`。
- 生效：**重启实例**（宿主模块在启动时装载；刷新页面无效）。
- 卸载：删 insert 段 + 删链接。

