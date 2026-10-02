# dsh-promote-on-timeout

> **把 DSH 0.1.7 的「超时任务自动转后台」带到 0.1.5-rc.3**：前台 shell 命令到达超时后**继续以后台任务运行**，而不是被杀掉。

- **只做一件事**：接管 `pwsh` / `bash` 的前台调用，超时即提升为 `ctx.jobs` 任务。
- **零外部依赖**：只用 `ctx` 服务 + Node 内置；不需要客户端半，不改任何现有文件。
- **可整块拆卸**：删掉 profile 里那条 insert 段即恢复原行为。

## 它复刻的是什么

`@deepseek-ai/dsh-tool-pwsh@0.1.7-rc.2` 的配置项 `promoteOnTimeout`（默认 `true`）：

> 到达超时的前台命令继续作为它的后台任务运行，而不是杀掉它。

0.1.5-rc.3 上同名的能力不存在（前台路径走 `ctx.shell.run()`，到点由执行器 deadline 杀掉）。本插件在 0.1.5 的既有接缝上重建同一套行为。

## 行为合同

| 场景 | 结果 |
|---|---|
| 命令在超时内结束 | 普通前台结果（正文 + `[exit code: N]` / `[killed by signal: X]` 标记），**不产生完成通知**，**也完全不进任务列表**（登记发生在窗口到期时） |
| 命令超过 `timeoutMs` 仍在跑 | `[still running after <timeoutMs>ms; moved to background job <id>]` + 交接指引，并附上**目前为止的输出**；`job_output` 从该处**接续**（同一条消费游标）。**侧边栏的任务行也在这一刻才出现**——见下节「登记时机」 |
| 提升后的命令自己结束 | 一条完成通知（`dsh-tool-jobs` 的既有机制），`job_list` / WebUI 任务列表可见 |
| 调用方取消（Esc） | 提升前后的等待期取消 → 任务被 kill 并等它结算，抛出 `AbortError`；**提升之后**命令不再受该调用约束（与 0.1.7 一致） |
| 注册被拒 / 无 job 注册表 / 配置关闭 | 原样退回内置行为（执行器 deadline 杀掉） |
| `run_in_background: true` | 不接管，交给内置实现 |
| 带 `sandbox_permissions` 的升权调用 | 不接管（插件 import 不到 `@deepseek-ai/dsh-sandbox`，交回内置自带审批实现） |

### 登记时机（与 0.1.7 的一处有意差异）

0.1.7 在命令**启动时**就把它登记成任务（其文档：「前台命令一启动就登记到 `ctx.jobs`……命令在运行期间始终被列出，并可从 Web 任务列表停止」）。本插件推迟到**等待窗口到期那一刻**才登记：

```
启动进程 (ctx.shell.start，无执行器 deadline)
   ├─ 窗口内结算 → 直接返回前台结果，注销/注册表零痕迹
   ├─ 窗口到期   → 这时才 jobs.start(绑定已在跑的进程) → 返回提升结果
   └─ 调用被取消 → 直接 proc.kill()（此时还没有任务）
```

**为什么改**：0.1.7 的写法会让侧边栏任务列表在命令启动时（而非转后台时）就出现一行 `running`，而 0.1.5 的 `JobSnapshot` 没有「仍在窗口内 / 已提升」的区分——用户会误判「转后台几乎立刻发生」。延后登记让**行出现在那一刻 == 真的转后台**。

**代价**：等待窗口内不能从任务列表停（0.1.7 明确要这条）。窗口内仍可用 **Esc 中断本回合**，插件收到 `exec.signal` 会直接杀掉进程，行为等价。

## 兼容性

| 项 | 值 |
|---|---|
| 实测环境 | DSH **0.1.5-rc.3**（win32 / pwsh 7）；只读核对过 0.1.7-rc.2 的对应实现 |
| 依赖的服务 | `ctx.shell`、`ctx.tools`（事件源）；运行时另取 `ctx.get("jobs")`、`ctx.get("shellEnv")`、`ctx.get("sandboxPolicy")` |
| 组合前提 | 加载 `dsh-jobs` + `dsh-jobs-local` + `dsh-tool-jobs`（base bundle 自带；`jobs.start()` 在无控制器时会拒绝，插件随即退回老行为） |
| 平台 | 与 `pwsh`/`bash` 工具同平台；本机只有 pwsh 行生效 |

## 安装 / 卸载

安装 = 两件事（见本目录 `AGENTS.md` §7）：
1. 在 `<home>/profiles/<profile>/node_modules/` 建符号链接指向本源码目录；
2. 在该 profile 的 `cordis.patch.yml` 加：

```yaml
- insert:
    - id: promote-on-timeout
      name: dsh-promote-on-timeout
```

**生效要重启实例**：宿主模块在启动时装载，刷新页面无效。

卸载 = 删上述 insert 段 + 删符号链接。插件不写注册表、不留后台服务；已在跑的后台任务属于 `ctx.jobs`，与插件无关。

## 配置

写在组合条目上（没有 `Config` schema，缺省即默认）：

```yaml
- id: promote-on-timeout
  name: dsh-promote-on-timeout
  config:
    promoteOnTimeout: true     # false = 整个能力关闭（与 0.1.7 同名同义）
    tools: [pwsh, bash]        # 只接管哪些 shell 工具
```

## 与 0.1.7 的已知差异

1. **只有「已提升 / 显式后台」的任务会留下已结算记录**：0.1.5 的 `JobRegistry` 没有 `remove()`，任务结束后那行会留在 `job_list` 里（已置 `reported`，不会重复播报完成）。窗口内结算的普通前台调用**完全不进列表**（本插件的延后登记）。
2. **结算支的 `value` 把 stdout/stderr 合并在 `stdout.text`**：0.1.5 的后台句柄只提供合并增量（`ShellProcess.readOutput()`），拿不到 `ShellRunResult` 的分离结构。模型可见文本一致（内置渲染本来就是「stdout + `[stderr]` 段」拼接）。
3. **升权调用不接管**（见上表）。
4. **`[stopped: <reason>]` 的来源更粗糙**：0.1.7 从任务终态 `detail` 取，这里只能取 `kill()` 的 reason。
5. **超长输出的截断点**取执行器的 `maxOutputBytes`，与内置**后台**路径一致、与前台路径的 `stdoutMaxBytes` 略有差别。

## 工作原理（三句话）

1. `ctx.on("tools/execute", …)` 注册一个包装器：该 waterfall 的 **fallback 就是工具本体**，所以「不调 `next()`」= 整体接管；pre-execute 的允许/拒绝/询问与守卫**在此之前已经跑过**。
2. 接管后：`ctx.shell.resolve(request)` 拿到执行器的**默认窗口与上限**（`timeoutMs`，默认 120000 / 上限 600000），用 `ctx.shell.start(spec)` 启动——**后台启动不设 deadline**，这正是「不杀」。
3. 把这个进程按 0.1.5 的 `JobStart` 形状登记进 `ctx.jobs`，然后 `jobs.wait(id, 窗口)`：窗口内结算 → 返回前台结果；仍在跑 → 返回 `background` 分支的 `value` + 一次消费式读取。

> **为什么提升支返回 `{ kind: "background", jobId }` 而不是 0.1.7 的 `{ kind: "promoted" }`**：`value` 必须过**内置工具自己声明的**输出 JSON Schema，而内置 schema 在本版本里改不了；`background` 分支语义为真（确实存在这个任务），且能让 UI 走任务卡片。

## 验证状态

| 项 | 状态 |
|---|---|
| `node --check lib/index.js` | ✅ 通过 |
| 离线冒烟 `.smoke/wrapper-test.mjs` | ✅ **ALL OK（66 断言）** —— 覆盖 10 组：导出面、5 类「交回本体」形态、结算支、提升支、注册被拒回退、调用取消、请求组装（workdir/dshEnv/沙箱策略）、`run()` 钩子契约与渲染、processOutcome、配置开关 |
| 实机验证（装插件 + 重启实例后） | ✅ **通过**（2026-09-29），逐条数据见下。⚠️ 下表 1–8 是在**「启动即登记」**那版实现上测的；提升时机、游标接续、通知计数、开关对照组这些**行为结论不受影响**，但「侧边栏何时出现行」已改为延后登记，语义由离线冒烟（83 断言）覆盖，实机复测待下次重启 |

### 实机验证记录（2026-09-29 · DSH 0.1.5-rc.3 · Windows / pwsh 7）

| # | 用例 | 实测结果 |
|---|---|---|
| 1 | 窗口内结算：`Write-Output 'quick-ok'`，`timeoutMs: 5000` | 683 ms 返回 `kind=foreground / exitCode=0`；**零完成通知**（终态读已置 `reported`） |
| 2 | 提升：输出一行后 `Start-Sleep 6`、共 9 s，`timeoutMs: 5000` | 5090 ms 返回 `kind=background / jobId=pwsh-2`；任务自然结束 → **恰好一条**完成通知 |
| 3 | 提升：总长 18 s，`timeoutMs: 5000` | 5075 ms 返回 `jobId=pwsh-3`；同样只有一条通知 |
| 4 | 回归：显式 `run_in_background: true` | 73 ms 立即返回 `jobId=pwsh-4` —— 内置路径逐字未变 |
| 5 | **消费游标接续**：总长 24 s、每 8 s 打一行时间戳 | 提升那一刻的单次读吃掉 `C-00`；+9 s 的 `job_output` 只给 `C-08`（**不重复 C-00**）；+17 s 只给 `C-16`（**不重复 C-08**） |
| 6 | 非零退出 | `exit 3` → `value.exitCode = 3`，任务 `detail = exit code: 3` |
| 7 | `job_list` | 6 个任务全部以 `kind: pwsh` 登记、终态带 detail；提升期间 `running` 可见 |

| 8 | **开关关闭**：`config.promoteOnTimeout: false`（改组合配置 + 重启实测） | `Start-Sleep 30` + `timeoutMs: 3000` → **3080 ms 被杀**、`kind=foreground / timedOut=true / exitCode=1`、正文空；`job_list` **一个新任务都没有**；`run_in_background: true` 仍正常（80 ms 返回 `pwsh-1`）—— 与插件装上之前逐字一致 |
> 未做：带 `sandbox_permissions` 的升权调用（会真的弹审批框；「交回内置」是构造性保证，离线冒烟已断言 `next()` 恰好被调用一次）。

## 风险

- **依赖 waterfall 的「不调 next() 即接管」语义**：这是 `dsh-tools` 的既有实现（`ctx.waterfall(..., () => this.dispatchToolBody(exec))`），但未见于公开文档的措辞；升级 Harness 后应重跑冒烟与实机清单。失效形态是「工具行为整体退回内置」而不是静默损坏。
- **接管期间不重写内置的参数校验**：参数非法时一律交回本体，由本体报它自己的错。

