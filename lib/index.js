/**
 * dsh-promote-on-timeout · 宿主半（单文件）
 *
 * 把 0.1.7 `@deepseek-ai/dsh-tool-pwsh` 的 `promoteOnTimeout` 行为移植到 0.1.5-rc.3：
 * 前台 shell 调用到达超时后**继续以后台任务身份运行**，而不是被执行器的 deadline 杀掉。
 *
 * 做法：注册一个 `tools/execute` 包装器。该 waterfall 的 fallback 就是工具本体
 * （dsh-tools@0.1.5-rc.3 lib/index.js:3213），所以「不调 next()」= 整体接管；
 * pre-execute（允许/拒绝/询问、单调守卫）在此之前已经跑过，审批语义不受影响。
 *
 * 只用 ctx 服务 + node 内置：profile 的 node_modules 里没有 @deepseek-ai scope，
 * 插件 import 不到 @deepseek-ai/dsh-{tools,jobs,shell,sandbox}。因此：
 *   · 带 sandbox_permissions（升权）的调用原样交回内置本体，复用它自己的审批实现；
 *   · 沙箱标记与渲染按 0.1.5 的原文逐字复刻（见各自函数注释里的出处）。
 *
 * 登记时机（与 0.1.7 的一处**有意差异**）：0.1.7 在命令**启动时**就登记任务；本插件推迟到
 * **窗口到期那一刻**才登记，因此侧边栏的任务列表只在真正转后台时出现该行 —— 普通前台调用
 * （含窗口内结算的）完全不进列表。代价：等待窗口内不能从任务列表停（仍可用 Esc 中断本回合，
 * 那时插件直接杀掉进程）。取舍与理由见 README 的「登记时机」一节。
 *
 * 用到的 0.1.5 接缝（逐条对齐，勿按 0.1.7 的形态写）：
 *   JobStart      = { kind, label, owner: Agent, run(): { cancel, done, readOutput } }
 *   ctx.jobs.wait = wait(id, timeoutMs, caller?, signal?) -> Promise<JobSnapshot>
 *   ctx.jobs.read = read(id, caller?) -> { text, snapshot }（单消费游标）
 *   ctx.shell     = resolve(request) -> spec；start(spec) 无执行器超时（后台语义）
 *   tools/execute 成功结果 = { isError: false, value, content }，且 value 必须过工具声明的
 *                   输出 JSON Schema（见 README 的「为什么返回 background 而不是 promoted」）。
 */
import { isAbsolute, resolve } from "node:path";

export const name = "promote-on-timeout";

/** 只为 ctx.shell 而注入：本插件不注册工具，只包 tools/execute。 */
export const inject = ["tools", "shell"];

/** 默认接管哪些工具：两者的参数面一致（command/description/timeoutMs/workdir[/run_in_background]）。 */
const DEFAULT_TARGETS = ["pwsh", "bash"];

/** 正整数毫秒判定；非法值不在这里报错，交回内置本体去报它自己的那句错。 */
function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** 沙箱拒绝标记 —— 逐字取自 @deepseek-ai/dsh-sandbox@0.1.5-rc.3 lib/index.js:64。 */
function sandboxDenialMarker(mode) {
	return `[sandbox: file access denied under ${mode} mode]`;
}

/** 同回合升权提示 —— 逐字取自 @deepseek-ai/dsh-sandbox@0.1.5-rc.3 lib/index.js:76。 */
function escalationHintMarker(subject) {
	return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}

/**
 * 一次后台读的模型可见文本：增量 + 丢字节提示（带全量 spill 路径）+ 沙箱提示。
 * 逐字移植 @deepseek-ai/dsh-tool-pwsh@0.1.5-rc.3 lib/index.js:90 的 renderPwshProcessRead。
 * @param read - ShellProcess.readOutput() 的一次消费式结果。
 * @param sandbox - 进程的沙箱事实（未沙箱时为 undefined）。
 * @param escalationModes - 本组合广告的升权目标；非空才追加升权提示。
 * @returns 模型可见文本。
 */
function renderProcessRead(read, sandbox, escalationModes) {
	const notices = [];
	if (read.lossy) {
		const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path) => path !== undefined);
		notices.push(`[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(", ") : "(unavailable)"}]`);
	}
	if (sandbox !== undefined && sandbox.runnerFailed === true) notices.push(`[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`);
	else if (sandbox !== undefined && sandbox.denied === true) {
		notices.push(sandboxDenialMarker(sandbox.mode));
		if (escalationModes.length > 0) notices.push(escalationHintMarker("command"));
	}
	if (notices.length === 0) return read.delta;
	return `${read.delta}${read.delta.length > 0 && !read.delta.endsWith("\n") ? "\n" : ""}${notices.join("\n")}`;
}

/**
 * 把一个已结算的后台进程映射成 job 的终态词汇。
 * 逐字移植 @deepseek-ai/dsh-tool-pwsh@0.1.5-rc.3 lib/index.js:22 的 processOutcome。
 * @param proc - 已结算的 ShellProcess。
 * @returns 交给 ctx.jobs 的 JobOutcome。
 */
function processOutcome(proc) {
	if (proc.status === "killed") return {
		status: "killed",
		detail: proc.signal !== null ? `signal: ${proc.signal}` : "killed before exit",
	};
	return {
		status: "completed",
		detail: `exit code: ${proc.exitCode ?? 0}`,
	};
}

/**
 * 工作目录解析，与内置 @deepseek-ai/dsh-tool-pwsh@0.1.5-rc.3 lib/index.js:150 的 resolveWorkdir 一致：
 * 模型显式给的相对路径按会话 header cwd 展开；没给则用会话 header cwd；都没有就留给执行器默认。
 * @param modelWorkdir - 工具参数 workdir（可能缺失）。
 * @param exec - 本次工具调用。
 * @returns 绝对/相对工作目录，或 undefined。
 */
function resolveWorkdir(modelWorkdir, exec) {
	const headerCwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd;
	if (modelWorkdir === undefined) return headerCwd;
	if (headerCwd !== undefined && !isAbsolute(modelWorkdir)) return resolve(headerCwd, modelWorkdir);
	return modelWorkdir;
}

/**
 * 组装 ShellExecRequest。沙箱策略按内置方式解析（会话的 mode/cwd 随策略下发）——
 * 不传的话会退化成执行器默认，等于把「会话级沙箱模式」丢掉。
 * @param ctx - 插件上下文。
 * @param args - 工具参数。
 * @param exec - 本次工具调用。
 * @returns ShellExecRequest。
 */
function buildRequest(ctx, args, exec) {
	const workdir = resolveWorkdir(args.workdir, exec);
	const shellEnv = ctx.get("shellEnv");
	const policy = resolveSandboxPolicy(ctx, exec);
	return {
		command: args.command,
		...(workdir !== undefined ? { workdir } : {}),
		...(positive(args.timeoutMs) ? { timeoutMs: args.timeoutMs } : {}),
		...(shellEnv !== undefined ? { dshEnv: shellEnv.collect(exec) } : {}),
		...(policy !== undefined ? { sandboxPolicy: policy } : {}),
	};
}

/**
 * 与本会话相关的沙箱策略；执行器不设限（shell.sandboxMode 为 undefined）时不解析。
 * @param ctx - 插件上下文。
 * @param exec - 本次工具调用。
 * @returns 已解析策略，或 undefined。
 */
function resolveSandboxPolicy(ctx, exec) {
	if (ctx.shell.sandboxMode === undefined) return undefined;
	const sandboxPolicy = ctx.get("sandboxPolicy");
	if (sandboxPolicy === undefined) return undefined;
	return sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
}

/**
 * 结算支的模型可见文本：正文（无输出记 (no output)）+ 停因/超时/信号/退出码标记。
 * 标记段逐字移植内置 renderPwshResult（lib/index.js:60），顺序同内置：停因 → 超时 → 信号/退出码。
 * @param body - 已渲染的正文（可能为空字符串）。
 * @param options - stopped（本调用杀停原因）/ timedOut / timeoutMs / exitCode / signal。
 * @returns 模型可见文本。
 */
function renderForeground(body, options) {
	const { stopped, timedOut = false, timeoutMs, exitCode, signal } = options;
	let text = body.length > 0 ? body : "(no output)";
	const markers = [];
	if (stopped !== undefined) markers.push(`[stopped: ${stopped}]`);
	if (timedOut) markers.push(`[timed out after ${timeoutMs}ms]`);
	if (signal !== null) markers.push(`[killed by signal: ${signal}]`);
	else if (exitCode !== null && exitCode !== 0) markers.push(`[exit code: ${exitCode}]`);
	if (markers.length === 0) return text;
	if (!text.endsWith("\n")) text += "\n";
	return text + markers.join("\n");
}

/**
 * 提升支的模型可见文本 —— 0.1.7 renderPwshPromoted 的等价物
 * （dsh-tool-pwsh@0.1.7-rc.2 lib/index.js:187 的措辞逐字照搬）。
 * @param jobId - 注册表签发的任务 id。
 * @param timeoutMs - 刚刚到期的等待窗口。
 * @param output - 本次消费式读取拿到的「目前为止的输出」。
 * @returns 模型可见文本。
 */
function renderPromoted(jobId, timeoutMs, output) {
	const head = output.length === 0 ? "" : output.endsWith("\n") ? output : `${output}\n`;
	return `${head}[still running after ${timeoutMs}ms; moved to background job ${jobId}]\n` +
		"The command keeps running in the background. You will be notified when it finishes; " +
		"read newer output with job_output, stop it with job_kill.";
}

/**
 * 结算支的 canonical value：必须过内置 pwsh 输出 schema 的 foreground 分支
 * （BACKGROUND_OUTPUT_PROPERTIES / foreground 的 required 字段见 dsh-tool-pwsh@0.1.5-rc.3 lib/index.js:181 与 :301）。
 * @param proc - 已结算的进程句柄。
 * @param timeoutMs - 本次调用的有效等待窗口（= 执行器解析出的 timeoutMs）。
 * @param text - 已完成渲染的合并输出正文。
 * @param timedOut - 是否由本调用的等待窗口/降级杀停截断。
 * @returns canonical foreground 值。
 */
function canonicalForegroundValue(proc, timeoutMs, text, timedOut = false) {
	const sandbox = proc.sandbox;
	return {
		kind: "foreground",
		exitCode: proc.exitCode,
		signal: proc.signal,
		timedOut,
		aborted: false,
		timeoutMs,
		stdout: { text, truncated: false },
		stderr: { text: "", truncated: false },
		...(sandbox !== undefined ? { sandbox: {
			mode: sandbox.mode,
			denied: sandbox.denied,
			...(sandbox.enforcement !== undefined ? { enforcement: sandbox.enforcement } : {}),
			...(sandbox.runnerFailed !== undefined ? { runnerFailed: sandbox.runnerFailed } : {}),
		} } : {}),
	};
}

/** 调用方取消：与内置同形（name=AbortError，message=tool call aborted）。 */
function abortError() {
	const error = new Error("tool call aborted");
	error.name = "AbortError";
	return error;
}

/**
 * 注册包装器。配置（composition entry 的 config 字段）：
 *   promoteOnTimeout: false  —— 整个能力关闭（与 0.1.7 同名同义）
 *   tools: ["pwsh"]          —— 只接管指定工具（默认 ["pwsh","bash"]）
 * @param ctx - 插件上下文。
 * @param config - 组合条目的配置对象。
 */
export function apply(ctx, config = {}) {
	if ((config.promoteOnTimeout ?? true) === false) return;
	const targets = new Set(Array.isArray(config.tools) ? config.tools : DEFAULT_TARGETS);
	ctx.effect(() => ctx.on("tools/execute", (exec, next) => intercept(ctx, targets, exec, next)), "promote-on-timeout: tools/execute");
}

/**
 * 等待一个已启动的进程：窗口内结算 / 窗口到期 / 调用被取消，取最先发生者。
 * 这是「延后登记」的核心 —— 窗口期内**不碰任务注册表**（侧边栏因此不会提前出现行），
 * 到期才去登记那个已经在跑的进程。
 * @param proc - 已由 ctx.shell.start() 启动的后台句柄。
 * @param waitMs - 执行器解析出的等待窗口（默认 120000 / 上限 600000）。
 * @param signal - 调用方取消信号（可缺省）。
 * @returns "settled" | "expire" | "abort"。
 */
function settleOrExpire(proc, waitMs, signal) {
	return new Promise((resolve) => {
		let timer;
		const finish = (outcome) => {
			clearTimeout(timer);
			if (signal !== undefined) signal.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const onAbort = () => finish("abort");
		timer = setTimeout(() => finish("expire"), waitMs);
		proc.done.then(() => finish("settled"), () => finish("settled"));
		if (signal === undefined) return;
		if (signal.aborted) { finish("abort"); return; }
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 一个前台 shell 调用的接管路径（延后登记版）：
 *   ① 先按**后台语义**启动进程（start() 无执行器 deadline，所以不会被杀）；
 *   ② 窗口内结算 → 直接返回普通前台结果，**全程不进任务注册表**；
 *   ③ 窗口到期 → 这时才用 ctx.jobs 登记这个**已经在跑**的进程，返回提升结果；
 *   ④ 调用被取消 → 直接杀掉进程（此时还没有任务，无需走注册表）。
 * @param ctx - 插件上下文。
 * @param targets - 接管的工具名集合。
 * @param exec - tools/execute 的委派执行视图（name/arguments/agent/signal）。
 * @param next - waterfall 的下一环（= 工具本体）。
 * @returns 规范化工具结果。
 */
async function intercept(ctx, targets, exec, next) {
	if (!targets.has(exec.name)) return next();
	const args = exec.arguments ?? {};
	/* 这些形态原样交回内置本体：强制后台、升权审批、以及参数非法（让本体报它自己的错）。 */
	if (args.run_in_background === true) return next();
	if (args.sandbox_permissions !== undefined || args.justification !== undefined) return next();
	if (typeof args.command !== "string" || args.command.trim().length === 0) return next();
	if (args.timeoutMs !== undefined && !positive(args.timeoutMs)) return next();
	const jobs = ctx.get("jobs");
	if (jobs === undefined) return next();

	/* resolve() 同时给出「默认窗口」与「上限」——正是内置前台路径会被杀掉的时刻。 */
	const spec = ctx.shell.resolve(buildRequest(ctx, args, exec));
	const waitMs = spec.timeoutMs;
	const escalationModes = ctx.shell.sandboxMode === undefined ? [] : ["workspace-write", "danger-full-access"];

	let proc;
	try {
		/* start() = 后台启动：执行器不设 deadline，命令不会被杀。 */
		proc = ctx.shell.start(spec);
	} catch (error) {
		/* 连进程都没起来：交回内置本体（它会以同样的方式失败，错误面保持一致）。 */
		ctx.logger.warn(`promote-on-timeout: background start failed, deferring to the built-in path: ${String(error)}`);
		return next();
	}

	const outcome = await settleOrExpire(proc, waitMs, exec.signal);

	if (outcome === "abort") {
		/* 调用被取消：还没有登记过任务，直接杀进程即可。 */
		proc.kill();
		await proc.done.catch(() => undefined);
		throw abortError();
	}

	if (outcome === "settled" || proc.status !== "running") {
		/* 窗口内结算（含「到期那一刻恰好结算」的竞态）：普通前台结果，零注册表痕迹。 */
		const text = renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes);
		return {
			isError: false,
			value: canonicalForegroundValue(proc, waitMs, text, false),
			content: [{ type: "text", text: renderForeground(text, { stopped: undefined, timedOut: false, timeoutMs: waitMs, exitCode: proc.exitCode, signal: proc.signal }) }],
		};
	}

	/* 到期仍在跑：**现在**才登记这个已经在跑的进程 —— 侧边栏的行与「转后台」同时发生。 */
	let stopped;
	let jobId;
	try {
		jobId = jobs.start({
			kind: exec.name,
			label: args.command,
			...(exec.agent !== undefined ? { owner: exec.agent } : {}),
			run: () => ({
				cancel: (reason) => {
					stopped = reason === undefined ? "killed" : String(reason);
					proc.kill();
				},
				done: proc.done.then(() => processOutcome(proc)),
				readOutput: () => renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
			}),
		});
	} catch (error) {
		/* 准入被拒（无控制器 / 持有者任务上限）：与 0.1.7 同款降级 —— 按 deadline 杀掉。
		   命令已经跑过了，这里**不能** next()（会跑第二遍）。 */
		ctx.logger.warn(`promote-on-timeout: job registration refused, falling back to the deadline kill: ${String(error)}`);
		proc.kill();
		await proc.done.catch(() => undefined);
		const text = renderProcessRead(proc.readOutput(), proc.sandbox, escalationModes);
		return {
			isError: false,
			value: canonicalForegroundValue(proc, waitMs, text, true),
			content: [{ type: "text", text: renderForeground(text, { stopped, timedOut: true, timeoutMs: waitMs, exitCode: proc.exitCode, signal: proc.signal }) }],
		};
	}

	/* 一次消费式读取把「目前为止的输出」交给模型，job_output 从此处接续。 */
	const read = jobs.read(jobId, exec.agent);
	return {
		isError: false,
		value: { kind: "background", jobId },
		content: [{ type: "text", text: renderPromoted(jobId, waitMs, read.text) }],
	};
}
