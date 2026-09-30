import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { interviewTestContext } from "./test-context.ts";

const run = promisify(execFile);
const BROWSER_STATE_TIMEOUT_MS = 10000;
const BROWSER_POLL_MS = 100;
const E2E_TIMEOUT_MS = 60000;

const CreatedTab = Type.Object({ ok: Type.Literal(true), result: Type.Object({ browserPageId: Type.String() }) });
const TabList = Type.Object({
	ok: Type.Literal(true),
	result: Type.Object({ tabs: Type.Array(Type.Object({ browserPageId: Type.String(), url: Type.String() })) }),
});
const Evaluation = Type.Object({ ok: Type.Literal(true), result: Type.Object({ result: Type.String() }) });
const ExecFailure = Type.Object({ message: Type.String(), stdout: Type.Optional(Type.String()) });
const ResultSchema = Type.Object({
	details: Type.Object({
		status: Type.String(), url: Type.String(),
		responses: Type.Array(Type.Object({ id: Type.String(), value: Type.String() })),
	}),
});
type Result = Static<typeof ResultSchema>;

it.skipIf(process.env.PI_INTERVIEW_ORCA_E2E !== "1")(
	"submits, retries a failed save, advances a queued form, and closes only the interview tab",
	async () => {
		const cwd = process.cwd();
		const cliEnv = { ...process.env };
		const home = mkdtempSync(join(tmpdir(), "pi-interview-orca-e2e-"));
		const snapshotDir = join(home, "snapshots");
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
			interview: { launcher: "orca", snapshotDir },
		}));
		process.env.HOME = home;
		const { default: extension } = await import("./index.ts");
		const shutdowns: (() => void)[] = [];
		const pages: string[] = [];
		const draftKeys = new Map<string, string>();
		const draftsAtClose: string[] = [];
		async function orca<T extends TSchema>(args: string[], schema: T) {
			let stdout: string;
			try {
				({ stdout } = await run("orca", [...args, "--json"], { cwd, env: cliEnv }));
			} catch (error) {
				Value.Assert(ExecFailure, error);
				throw new Error(error.stdout || error.message);
			}
			const response: unknown = JSON.parse(stdout);
			Value.Assert(schema, response);
			return response;
		}
		const pageList = async () => (await orca(["tab", "list"], TabList)).result.tabs;
		const evaluate = async (page: string, expression: string) => (await orca(["eval", "--page", page, "--expression", expression], Evaluation)).result.result;
		const until = async (predicate: () => Promise<boolean>) => {
			const deadline = Date.now() + BROWSER_STATE_TIMEOUT_MS;
			while (!await predicate()) {
				assert.ok(Date.now() < deadline, "Browser did not reach the expected state");
				await new Promise(resolve => setTimeout(resolve, BROWSER_POLL_MS));
			}
		};
		function start(title: string, async: boolean) {
			let execute: ToolDefinition["execute"] | undefined;
			let launch!: (value: { page: string; url: string }) => void;
			const launched = new Promise<{ page: string; url: string }>(resolve => { launch = resolve; });
			let deliver!: (value: Result) => void;
			const delivered = new Promise<Result>(resolve => { deliver = resolve; });
			let page = "";
			const on = vi.fn();
			const api: Pick<ExtensionAPI, "on" | "registerTool" | "sendMessage" | "exec"> = {
				registerTool: tool => { execute = tool.execute; },
				on,
				sendMessage: message => {
					Value.Assert(ResultSchema, message);
					deliver(message);
				},
				exec: async (command, args, options) => {
					if (args[1] === "close") {
						const closingPage = args[args.indexOf("--page") + 1]!;
						const key = draftKeys.get(closingPage);
						assert.ok(key);
						draftsAtClose.push(await evaluate(closingPage, `localStorage.getItem(${JSON.stringify(key)})`));
					}
					const result = await run(command, args, { ...options, env: cliEnv });
					if (args[1] === "create") {
						const created: unknown = JSON.parse(result.stdout);
						Value.Assert(CreatedTab, created);
						page = created.result.browserPageId;
						pages.push(page);
					}
					if (args[0] === "goto") launch({ page, url: args[args.indexOf("--url") + 1]! });
					return { ...result, code: 0, killed: false };
				},
			};
			// SAFETY: The interview uses only these four Pi API methods.
			extension(api as ExtensionAPI);
			// SAFETY: The factory registers one shutdown callback that reads neither event nor context.
			shutdowns.push(on.mock.calls[0]![1] as () => void);
			const result = execute!(title, {
				async, questions: JSON.stringify({
					title, questions: [{ id: "answer", type: "text", question: title }],
				}),
			}, undefined, undefined, interviewTestContext(cwd)).then(result => {
				Value.Assert(ResultSchema, result);
				return result;
			});
			return { launched, result, delivered };
		}
		const submit = async (page: string, answer: string) => {
			await until(async () => await evaluate(page, "Boolean(document.querySelector('textarea[data-question-id=answer]'))") === "true");
			await evaluate(page,
				`const input = document.querySelector('textarea[data-question-id=answer]');
				input.value = ${JSON.stringify(answer)};
				input.dispatchEvent(new Event('input', { bubbles: true })); true`);
			const draftKeyExpression = `Object.keys(localStorage).find(key => key.startsWith('pi-interview-') && localStorage.getItem(key).includes(${JSON.stringify(answer)})) || ''`;
			await until(async () => (await evaluate(page, draftKeyExpression)) !== "");
			const draftKey = await evaluate(page, draftKeyExpression);
			draftKeys.set(page, draftKey);
			await evaluate(page, "document.getElementById('interview-form').requestSubmit(); true");
			return draftKey;
		};
		try {
			const unrelated = (await orca(["tab", "create", "--url", "about:blank"], CreatedTab)).result.browserPageId;
			pages.push(unrelated);
			writeFileSync(snapshotDir, "force autosave failure");
			const first = start("Autosave retry", false);
			const opened = await first.launched;
			const tabsBeforeQueue = (await pageList()).map(tab => tab.browserPageId);
			const second = start("Queued interview", true);
			const queued = await second.result;
			assert.equal(queued.details.status, "started");
			assert.deepEqual((await pageList()).map(tab => tab.browserPageId), tabsBeforeQueue);
			await evaluate(opened.page, `window.__interviewRequestFields = {};
				const originalFetch = window.fetch.bind(window);
				window.fetch = (url, options) => {
					if (url === '/submit' || url === '/save') {
						window.__interviewRequestFields[url] = Object.hasOwn(JSON.parse(options.body), 'savedOptionInsights');
					}
					return originalFetch(url, options);
				}; true`);
			const firstDraftKey = await submit(opened.page, "first answer");
			const firstResult = await first.result;
			assert.equal(firstResult.details.status, "completed");
			assert.deepEqual(firstResult.details.responses, [{ id: "answer", value: "first answer" }]);
			await until(async () => await evaluate(opened.page, "document.getElementById('submit-btn').textContent") === "Retry save");
			assert.match(await evaluate(opened.page, "document.getElementById('error-container').textContent"), /answers.*sent/i);
			assert.equal(await evaluate(opened.page, "window.__interviewRequestFields['/submit']"), "false");
			assert.equal(await evaluate(opened.page, "window.__interviewRequestFields['/save']"), "true");
			assert.ok((await pageList()).some(p => p.browserPageId === opened.page));

			assert.equal(await evaluate(opened.page, `localStorage.getItem(${JSON.stringify(firstDraftKey)}) !== null`), "true");
			renameSync(snapshotDir, snapshotDir + "-blocker");
			await evaluate(opened.page, "document.getElementById('submit-btn').click(); true");
			await until(async () => (await pageList()).some(p => p.browserPageId === opened.page && p.url === queued.details.url));
			assert.equal((await pageList()).filter(tab => tab.url === queued.details.url).length, 1);
			await submit(opened.page, "second answer");
			const secondResult = await second.delivered;
			assert.equal(secondResult.details.status, "completed");
			assert.deepEqual(secondResult.details.responses, [{ id: "answer", value: "second answer" }]);
			await until(async () => !(await pageList()).some(p => p.browserPageId === opened.page));
			assert.ok((await pageList()).some(p => p.browserPageId === unrelated));
			assert.deepEqual(draftsAtClose, ["null"]);
			const snapshots = readdirSync(snapshotDir).map(name => readFileSync(join(snapshotDir, name, "index.html"), "utf8"));
			assert.ok(snapshots.some(html => html.includes("first answer")));
			assert.ok(snapshots.some(html => html.includes("second answer")));

			writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
				interview: { launcher: "orca", snapshotDir, autoSaveOnSubmit: false },
			}));
			const third = start("Autosave retry", true);
			const thirdPage = await third.launched;
			await third.result;
			assert.equal(new URL(thirdPage.url).origin, new URL(opened.url).origin);
			await until(async () => await evaluate(thirdPage.page, "Boolean(document.querySelector('textarea[data-question-id=answer]'))") === "true");
			assert.equal(await evaluate(thirdPage.page, `localStorage.getItem(${JSON.stringify(firstDraftKey)})`), "null");
			assert.equal(await evaluate(thirdPage.page, "document.querySelector('textarea[data-question-id=answer]').value"), "");
			const thirdDraftKey = await submit(thirdPage.page, "third answer");
			const thirdResult = await third.delivered;
			assert.equal(thirdResult.details.status, "completed");
			assert.deepEqual(thirdResult.details.responses, [{ id: "answer", value: "third answer" }]);
			await until(async () => !(await pageList()).some(p => p.browserPageId === thirdPage.page));
			assert.ok((await pageList()).some(p => p.browserPageId === unrelated));
			assert.equal(readdirSync(snapshotDir).length, 2);
			assert.deepEqual(draftsAtClose, ["null", "null"]);
			const reopened = start("Autosave retry", true);
			const reopenedPage = await reopened.launched;
			await reopened.result;
			assert.equal(new URL(reopenedPage.url).origin, new URL(thirdPage.url).origin);
			await until(async () => await evaluate(reopenedPage.page, "Boolean(document.querySelector('textarea[data-question-id=answer]'))") === "true");
			assert.equal(await evaluate(reopenedPage.page, `localStorage.getItem(${JSON.stringify(thirdDraftKey)})`), "null");
			assert.equal(await evaluate(reopenedPage.page, "document.querySelector('textarea[data-question-id=answer]').value"), "");
			console.log(JSON.stringify({
				result: "passed", blocking: true, async: true, failedSaveRetry: true,
				queueUsedSameTab: true, singleQueuedTab: true, draftCleared: true, failedSaveRetainedDraft: true, autoSaveDisabled: true, snapshots: readdirSync(snapshotDir).length, unrelatedTabPreserved: true,
			}));
		} finally {
			for (const shutdown of shutdowns) shutdown();
			const remaining = await pageList();
			for (const page of pages) {
				if (remaining.some(p => p.browserPageId === page)) await orca(["tab", "close", "--page", page], Type.Object({ ok: Type.Literal(true) }));
			}
			process.env.HOME = cliEnv.HOME;
			rmSync(home, { recursive: true, force: true });
		}
	},
	E2E_TIMEOUT_MS,
);
