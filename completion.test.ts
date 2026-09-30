import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { interviewTestContext } from "./test-context.ts";

const home = mkdtempSync(join(tmpdir(), "pi-interview-completion-"));
const snapshotDir = join(home, "snapshots");
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({
	interview: { launcher: "orca", snapshotDir, port: 0 },
}));
process.env.HOME = home;
const { default: interviewExtension } = await import("./index.ts");

const ResultSchema = Type.Object({ details: Type.Object({ status: Type.String(), url: Type.String() }) });
type Result = Static<typeof ResultSchema>;
type RequestBody = Partial<{ token: string; responses: { id: string; value: string }[]; submitted: boolean; reason: string }>;
const shutdowns: (() => void)[] = [];
afterEach(() => { for (const shutdown of shutdowns.splice(0)) shutdown(); });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function startInterview() {
	let execute: ToolDefinition["execute"] | undefined;
	let url = "";
	let failClose = false;
	const opened: string[][] = [];
	const closed: string[][] = [];
	const messages: Result[] = [];
	let deliver!: (message: Result) => void;
	const delivered = new Promise<Result>(resolve => { deliver = resolve; });
	const on = vi.fn();
	const api: Pick<ExtensionAPI, "registerTool" | "on" | "exec" | "sendMessage"> = {
		registerTool: tool => { execute = tool.execute; },
		on,
		exec: async (_command: string, args: string[]) => {
			if (args[1] === "create") opened.push(args);
			if (args[1] === "close") {
				closed.push(args);
				if (failClose) return { code: 1, stdout: "", stderr: "close failed", killed: false };
			}
			const result = args[1] === "list"
				? { tabs: [
					{ browserPageId: "unrelated", url: "https://example.com", worktreeId: "other" },
					{ browserPageId: "interview-page", url, worktreeId: "original-worktree" },
				] }
				: { browserPageId: "interview-page" };
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "", killed: false };
		},
		sendMessage: message => {
			Value.Assert(ResultSchema, message);
			messages.push(message);
			deliver(message);
		},
	};
	// SAFETY: The interview uses only these four Pi API methods.
	interviewExtension(api as ExtensionAPI);
	// SAFETY: The factory registers one shutdown callback that reads neither event nor context.
	shutdowns.push(on.mock.calls[0]![1] as () => void);
	const started = await execute!("test", {
		questions: JSON.stringify({ questions: [{ id: "name", type: "text", question: "Name?" }] }),
		async: true,
	}, undefined, undefined, interviewTestContext(home));
	Value.Assert(ResultSchema, started);
	url = started.details.url;
	return {
		url, opened, closed, messages, delivered,
		failClose: (value: boolean) => { failClose = value; },
		post: (route: string, body: RequestBody = {}) => fetch(new URL(route, url), {
			method: "POST",
			headers: { "Content-Type": "application/json", Connection: "close" },
			body: JSON.stringify({ token: new URL(url).searchParams.get("session"), ...body }),
		}),
	};
}

const answer = { responses: [{ id: "name", value: "Ada" }], submitted: true };

it("delivers answers once, keeps failed saves retryable, and closes only the matching tab after saving", async () => {
	writeFileSync(snapshotDir, "block snapshot creation");
	const form = await startInterview();
	expect((await form.post("/submit", answer)).status).toBe(200);
	await form.delivered;
	expect(form.messages).toHaveLength(1);
	expect((await form.post("/save", answer)).status).toBe(500);
	expect(form.closed).toHaveLength(0);
	expect((await form.post("/finish")).status).toBe(409);

	renameSync(snapshotDir, snapshotDir + "-blocker");
	expect((await form.post("/save", answer)).status).toBe(200);
	const snapshot = readdirSync(snapshotDir)[0]!;
	expect(readFileSync(join(snapshotDir, snapshot, "index.html"), "utf8")).toContain("Ada");
	expect((await form.post("/finish")).status).toBe(200);
	expect(form.closed).toEqual([["tab", "close", "--page", "interview-page", "--worktree", "id:original-worktree"]]);
	expect(form.messages).toHaveLength(1);
});

it("keeps a queued interview in the tab and lets its final submission close it", async () => {
	const first = await startInterview();
	const second = await startInterview();
	expect(second.opened).toHaveLength(0);
	await first.post("/submit", answer);
	await first.delivered;
	await first.post("/save", answer);
	const next = await first.post("/finish");
	expect(await next.json()).toMatchObject({ ok: true, nextUrl: second.url });
	expect(first.closed).toHaveLength(0);

	await second.post("/submit", answer);
	await second.delivered;
	await second.post("/save", answer);
	expect((await second.post("/finish")).status).toBe(200);
	expect(second.closed).toHaveLength(1);
});

it("closes the submitted form instead of duplicating an interview opened while saving", async () => {
	const first = await startInterview();
	await first.post("/submit", answer);
	await first.delivered;
	const later = await startInterview();
	expect(later.opened).toHaveLength(1);

	await first.post("/save", answer);
	const finished = await first.post("/finish");
	expect(await finished.json()).toMatchObject({ ok: true, nextUrl: null });
	expect(first.closed).toHaveLength(1);
	expect(later.closed).toHaveLength(0);
	expect((await later.post("/submit", answer)).status).toBe(200);
	await later.delivered;
});

it("reports close failures and retries without delivering answers twice", async () => {
	const form = await startInterview();
	await form.post("/submit", answer);
	await form.delivered;
	await form.post("/save", answer);
	form.failClose(true);
	expect((await form.post("/finish")).status).toBe(500);
	form.failClose(false);
	expect((await form.post("/finish")).status).toBe(200);
	expect(form.messages).toHaveLength(1);
});

it("rejects premature and unauthenticated finalization and releases submitted servers on shutdown", async () => {
	const form = await startInterview();
	expect((await form.post("/finish")).status).toBe(409);
	await form.post("/submit", answer);
	await form.delivered;
	await form.post("/save", answer);
	expect((await form.post("/finish", { token: "wrong" })).status).toBe(403);
	expect(form.closed).toHaveLength(0);
	for (const shutdown of shutdowns.splice(0)) shutdown();
	await expect(fetch(form.url)).rejects.toThrow();
});

it("cancels an unanswered interview without leaving its server running", async () => {
	const form = await startInterview();
	expect((await form.post("/cancel", { reason: "user" })).status).toBe(200);
	await form.delivered;
	await expect(fetch(form.url)).rejects.toThrow();
	expect(form.closed).toHaveLength(0);
});
