/**
 * dsh-promote-on-timeout · 离线冒烟（只读；不碰任何工作区、不起真实进程）
 *
 * 直接 import 真源码 ../lib/index.js（不是副本），用桩 ctx 跑用例表。
 * 覆盖「延后登记」语义：窗口内结算 → **零注册表痕迹**；窗口到期 → 才 jobs.start。
 * 期望输出末行：ALL OK (n assertions)。
 *
 * 跑法（在源码目录下）：node .smoke/wrapper-test.mjs
 * ⚠️ 用 pwsh 直接跑，不要在 node 里 execFileSync(..., { stdio: "pipe" })：沙箱下会 EPERM。
 */
import { resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(pathResolve(import.meta.dirname, "../lib/index.js")).href);

let passed = 0;
const failures = [];
function ok(condition, label, detail) {
	if (condition) { passed += 1; return; }
	failures.push(label + (detail === undefined ? "" : "  ->  " + JSON.stringify(detail)));
}
function eq(actual, expected, label) { ok(Object.is(actual, expected), label, { actual, expected }); }
function has(text, needle, label) { ok(typeof text === "string" && text.includes(needle), label, { text }); }
const tick = () => new Promise((r) => setTimeout(r, 0));
const AGENT = { id: "session-1", session: { header: { cwd: "C:/ws" } } };
const COMMAND = "Get-Process";
const WINDOW = 30;

function harness(opts = {}) {
	const log = { resolve: [], start: [], jobStart: 0, jobSpec: undefined, hooks: undefined, read: [], kill: [], warnings: [], nextCalls: 0, handlers: [], order: [] };
	let releaseDone;
	const proc = {
		status: "running", exitCode: null, signal: null, sandbox: opts.sandbox,
		killCalls: 0,
		kill() { this.killCalls += 1; this.status = "killed"; log.order.push("proc.kill"); return true; },
		done: new Promise((res) => { releaseDone = res; }),
		readOutput: () => opts.readOutput ?? { delta: "", lossy: false },
	};
	const jobs = {
		start(spec) {
			log.jobStart += 1; log.jobSpec = spec; log.order.push("job.start");
			if (opts.jobThrows === true) throw new Error("background jobs unavailable: no job controller serves this agent");
			log.hooks = spec.run();
			return "pwsh-1";
		},
		read(id, caller) { log.read.push({ id, caller }); return { text: opts.readText ?? "", snapshot: { id, status: "running" } }; },
		kill(id, caller, reason) { log.kill.push({ id, caller, reason }); return "requested"; },
	};
	const services = {
		jobs: opts.noJobs === true ? undefined : jobs,
		shellEnv: { collect: (exec) => ({ DSH_WORKSPACE: "W", agentSeen: exec.agent !== undefined }) },
		sandboxPolicy: { resolve: (arg) => ({ mode: "workspace-write", session: arg.session === undefined ? null : arg.session.header.cwd }) },
	};
	const ctx = {
		shell: {
			sandboxMode: opts.confined === false ? undefined : "workspace-write",
			resolve(request) {
				log.resolve.push(request);
				return { command: request.command, workdir: request.workdir ?? "C:/default", timeoutMs: opts.window ?? WINDOW, stdoutMaxBytes: 64000 };
			},
			start(spec) { log.start.push(spec); log.order.push("proc.start"); if (opts.startThrows === true) throw new Error("spawn failed"); return proc; },
		},
		get(key) { return services[key]; },
		logger: { warn: (message) => log.warnings.push(String(message)) },
		effect(fn) { return fn(); },
		on(event, handler) { if (event === "tools/execute") log.handlers.push(handler); return () => {}; },
	};
	return { ctx, log, proc, releaseDone };
}

async function run(opts = {}, args = {}, extra = {}) {
	const h = harness(opts);
	mod.apply(h.ctx, extra.config ?? {});
	const controller = new AbortController();
	const exec = {
		name: extra.name ?? "pwsh",
		arguments: { command: COMMAND, description: "List running processes", ...args },
		agent: extra.agent ?? AGENT,
		signal: extra.signal ?? controller.signal,
	};
	const next = () => { h.log.nextCalls += 1; return Promise.resolve({ isError: false, value: { kind: "foreground", fromNext: true }, content: [{ type: "text", text: "BODY-FROM-BODY" }] }); };
	const handler = h.log.handlers[0];
	let result; let error;
	if (handler !== undefined) {
		const pending = handler(exec, next);
		if (extra.abortAfterMs !== undefined) setTimeout(() => controller.abort(), extra.abortAfterMs);
		if (extra.settleAfterMs !== undefined) setTimeout(() => {
			const s = extra.settleWith;
			if (s !== undefined) { h.proc.status = s.status ?? "completed"; h.proc.exitCode = s.exitCode ?? 0; h.proc.signal = s.signal ?? null; }
			h.releaseDone();
		}, extra.settleAfterMs);
		try { result = await pending; } catch (thrown) { error = thrown; }
	}
	return { ...h, result, error, controller };
}

/* ---------- 1. 导出面 ---------- */
eq(mod.name, "promote-on-timeout", "导出 name");
ok(Array.isArray(mod.inject) && mod.inject.join(",") === "tools,shell", "导出 inject", mod.inject);
ok(typeof mod.apply === "function", "导出 apply");

/* ---------- 2. 该交回本体的形态（都不许动进程/注册表） ---------- */
for (const [label, opts, args, extra] of [
	["非目标工具", {}, {}, { name: "read" }],
	["run_in_background", {}, { run_in_background: true }, {}],
	["升权调用", {}, { sandbox_permissions: "danger-full-access", justification: "need it" }, {}],
	["空命令", {}, { command: "   " }, {}],
	["非法 timeoutMs", {}, { timeoutMs: 0 }, {}],
	["无 jobs 服务", { noJobs: true }, {}, {}],
]) {
	const r = await run(opts, args, extra);
	eq(r.log.nextCalls, 1, label + " -> next 一次");
	eq(r.log.start.length, 0, label + " -> 不启动进程");
	eq(r.log.jobStart, 0, label + " -> 不登记任务");
}

/* ---------- 3. 窗口内结算：零注册表痕迹 ---------- */
{
	const r = await run({ readText: "", readOutput: { delta: "hello", lossy: false } }, { timeoutMs: 1111 }, { settleAfterMs: 5 });
	eq(r.log.nextCalls, 0, "窗口内结算：不调 next");
	eq(r.log.start.length, 1, "窗口内结算：启动一次进程");
	eq(r.log.jobStart, 0, "窗口内结算：**从不登记任务**（侧边栏无痕）");
	eq(r.log.read.length, 0, "窗口内结算：不读注册表");
	eq(r.result.isError, false, "窗口内结算：isError=false");
	eq(r.result.value.kind, "foreground", "窗口内结算：value.kind");
	eq(r.result.value.timedOut, false, "窗口内结算：timedOut=false");
	eq(r.result.value.timeoutMs, WINDOW, "窗口内结算：value.timeoutMs = 执行器窗口");
	eq(r.result.value.stdout.text, "hello", "窗口内结算：正文来自消费式读");
	eq(r.result.content[0].text, "hello", "窗口内结算：干净退出无标记");
	eq(r.log.resolve[0].timeoutMs, 1111, "窗口内结算：args.timeoutMs 已送进 resolve");
}

/* ---------- 4. 到期 → 这才登记 ---------- */
{
	const r = await run({ readText: "so-far" }, {});
	eq(r.log.nextCalls, 0, "提升：不调 next");
	eq(r.log.start.length, 1, "提升：先启动进程");
	eq(r.log.jobStart, 1, "提升：到期才登记任务");
	ok(r.log.order.indexOf("job.start") > r.log.order.indexOf("proc.start"), "提升：登记发生在启动之后", r.log.order);
	eq(r.log.jobSpec.kind, "pwsh", "提升：kind = 工具名");
	eq(r.log.jobSpec.label, COMMAND, "提升：label = 命令行");
	eq(r.log.jobSpec.owner, AGENT, "提升：owner = Agent 实例");
	ok(typeof r.log.hooks.cancel === "function" && r.log.hooks.done instanceof Promise && typeof r.log.hooks.readOutput === "function", "提升：run() 返回合规钩子");
	eq(r.result.value.kind, "background", "提升：value 用 background 分支");
	eq(r.result.value.jobId, "pwsh-1", "提升：value.jobId");
	has(r.result.content[0].text, "so-far", "提升：带上目前为止的输出");
	has(r.result.content[0].text, "[still running after " + WINDOW + "ms; moved to background job pwsh-1]", "提升：0.1.7 同款措辞");
	has(r.result.content[0].text, "job_output", "提升：交接指引");
	eq(r.log.read.length, 1, "提升：一次消费式读取");
	eq(r.log.kill.length, 0, "提升：不 kill");
}

/* ---------- 5. 到期但准入被拒 → 按 deadline 杀掉（不回 next，命令已跑过） ---------- */
{
	const r = await run({ jobThrows: true, readOutput: { delta: "partial", lossy: false } }, {}, { settleAfterMs: WINDOW + 15, settleWith: { status: "killed", exitCode: null, signal: null } });
	eq(r.log.nextCalls, 0, "准入被拒：绝不 next（否则命令跑两遍）");
	eq(r.log.jobStart, 1, "准入被拒：确实尝试过登记");
	eq(r.proc.killCalls, 1, "准入被拒：杀掉进程");
	eq(r.result.value.kind, "foreground", "准入被拒：返回前台结果");
	eq(r.result.value.timedOut, true, "准入被拒：timedOut=true");
	has(r.result.content[0].text, "[timed out after " + WINDOW + "ms]", "准入被拒：超时标记");
	ok(r.log.warnings.some((w) => w.includes("registration refused")), "准入被拒：有降级日志", r.log.warnings);
}

/* ---------- 6. 调用被取消（窗口内） ---------- */
{
	const r = await run({}, {}, { abortAfterMs: 5, settleAfterMs: 20, settleWith: { status: "killed", exitCode: null, signal: null } });
	ok(r.error !== undefined && r.error.name === "AbortError", "取消：抛 AbortError", r.error === undefined ? null : r.error.name);
	eq(r.proc.killCalls, 1, "取消：杀掉进程");
	eq(r.log.jobStart, 0, "取消：从未登记任务");
	eq(r.log.nextCalls, 0, "取消：不调 next");
}

/* ---------- 7. 进程起不来 → 交回内置 ---------- */
{
	const r = await run({ startThrows: true }, {});
	eq(r.log.nextCalls, 1, "spawn 失败：交回内置本体");
	eq(r.log.jobStart, 0, "spawn 失败：不登记任务");
	ok(r.log.warnings.some((w) => w.includes("background start failed")), "spawn 失败：有日志", r.log.warnings);
}

/* ---------- 8. 到期那一刻恰好已结算（竞态护栏） ---------- */
{
	const h = harness({ readText: "" });
	mod.apply(h.ctx, {});
	const exec = { name: "pwsh", arguments: { command: COMMAND, description: "x" }, agent: AGENT, signal: new AbortController().signal };
	const pending = h.log.handlers[0](exec, () => { h.log.nextCalls += 1; return Promise.resolve({}); });
	h.proc.status = "completed"; h.proc.exitCode = 0; h.releaseDone();
	const r = await pending;
	eq(h.log.jobStart, 0, "竞态：已结算则绝不登记");
	eq(r.value.kind, "foreground", "竞态：按前台结果返回");
}

/* ---------- 9. 请求组装 ---------- */
{
	const r = await run({}, { timeoutMs: 1000, workdir: "sub" });
	eq(r.log.resolve[0].workdir, pathResolve("C:/ws", "sub"), "相对 workdir 按会话 cwd 展开");
	eq(r.log.resolve[0].dshEnv.DSH_WORKSPACE, "W", "dshEnv 来自 shellEnv.collect");
	eq(r.log.resolve[0].sandboxPolicy.mode, "workspace-write", "sandboxPolicy 已解析下发");
}
{
	const r = await run({}, { timeoutMs: 1000, workdir: "D:/elsewhere" });
	eq(r.log.resolve[0].workdir, "D:/elsewhere", "绝对 workdir 原样");
}
{
	const r = await run({}, { timeoutMs: 1000 });
	eq(r.log.resolve[0].workdir, "C:/ws", "无 workdir -> 会话 header cwd");
}
{
	const r = await run({ confined: false }, { timeoutMs: 1000 });
	eq(r.log.resolve[0].sandboxPolicy, undefined, "不设限执行器 -> 不传 sandboxPolicy");
}

/* ---------- 10. 渲染与钩子契约 ---------- */
{
	const r = await run({ readOutput: { delta: "abc", lossy: true, stdoutSpillPath: "C:/spill/out" } }, {}, { settleAfterMs: 5 });
	has(r.result.content[0].text, "[some output was dropped from memory; full output: C:/spill/out]", "渲染：丢字节提示带 spill 路径");
	eq(r.log.jobStart, 0, "渲染：结算支依旧零注册表痕迹");
}
{
	const r = await run({ readOutput: { delta: "boom", lossy: false } }, {}, { settleAfterMs: 5, settleWith: { exitCode: 3 } });
	has(r.result.content[0].text, "[exit code: 3]", "渲染：非零退出标记");
	eq(r.result.value.exitCode, 3, "渲染：value.exitCode=3");
}
{
	const r = await run({ readOutput: { delta: "", lossy: false } }, {}, { settleAfterMs: 5, settleWith: { exitCode: 0 } });
	eq(r.result.content[0].text, "(no output)", "渲染：空输出");
}
{
	const r = await run({ readOutput: { delta: "", lossy: false } }, {}, { settleAfterMs: 5, settleWith: { status: "killed", exitCode: null, signal: "SIGKILL" } });
	has(r.result.content[0].text, "[killed by signal: SIGKILL]", "渲染：信号标记");
}
{
	const h = harness({ readOutput: { delta: "x", lossy: false } });
	mod.apply(h.ctx, {});
	const exec = { name: "pwsh", arguments: { command: COMMAND, description: "x" }, agent: AGENT, signal: new AbortController().signal };
	const pending = h.log.handlers[0](exec, () => Promise.resolve({}));
	await new Promise((r) => setTimeout(r, WINDOW + 20));
	const hooks = h.log.hooks;
	has(hooks.readOutput(), "x", "钩子：readOutput 渲染增量");
	hooks.cancel("stopped from ui");
	eq(h.proc.killCalls, 1, "钩子：cancel -> proc.kill");
	let outcome; hooks.done.then((v) => { outcome = v; });
	h.proc.status = "completed"; h.proc.exitCode = 7; h.releaseDone();
	await tick(); await tick();
	eq(outcome.status, "completed", "processOutcome：completed");
	eq(outcome.detail, "exit code: 7", "processOutcome：detail 带退出码");
	await pending;
}
{
	const h = harness({ sandbox: { mode: "workspace-write", denied: true }, readOutput: { delta: "", lossy: false } });
	mod.apply(h.ctx, {});
	const exec = { name: "pwsh", arguments: { command: COMMAND, description: "x" }, agent: AGENT, signal: new AbortController().signal };
	const pending = h.log.handlers[0](exec, () => Promise.resolve({}));
	await new Promise((r) => setTimeout(r, WINDOW + 20));
	has(h.log.hooks.readOutput(), "[sandbox: file access denied under workspace-write mode]", "渲染：沙箱拒绝标记");
	await pending;
}

/* ---------- 11. 配置开关 ---------- */
{
	const r = await run({}, {}, { config: { promoteOnTimeout: false } });
	eq(r.log.handlers.length, 0, "promoteOnTimeout=false -> 不注册");
}
{
	const r = await run({}, { timeoutMs: 1000 }, { config: { tools: ["bash"] } });
	eq(r.log.nextCalls, 1, "tools=[bash] -> pwsh 不接管");
}
{
	const r = await run({}, { timeoutMs: 1000 }, { name: "bash" });
	eq(r.log.nextCalls, 0, "默认也接管 bash");
}

if (failures.length === 0) {
	console.log("ALL OK (" + passed + " assertions)");
} else {
	console.log("FAILED " + failures.length + " / " + (passed + failures.length));
	for (const line of failures) console.log("  · " + line);
	process.exitCode = 1;
}
