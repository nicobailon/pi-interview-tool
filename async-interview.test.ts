import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// Settings load from $HOME when index.ts is imported. The Orca launcher routes every
// launch through pi.exec, so the stub below keeps tests from opening real windows.
const home = mkdtempSync(join(tmpdir(), "pi-interview-async-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ interview: { launcher: "orca" } }));
process.env.HOME = home;
const { default: interviewExtension } = await import("./index.ts");

type Execute = (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { status: string; url: string } }>;

function startAsyncInterview() {
	let execute: Execute | undefined;
	let shutdown: (() => void) | undefined;
	const messages: unknown[][] = [];
	let delivered: (message: unknown[]) => void = () => {};
	const nextMessage = new Promise<unknown[]>((resolve) => { delivered = resolve; });
	interviewExtension({
		registerTool: (tool: { execute: Execute }) => { execute = tool.execute; },
		on: (event: string, handler: () => void) => { if (event === "session_shutdown") shutdown = handler; },
		exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { browserPageId: "page-1" } }), stderr: "", killed: false }),
		sendMessage: (...args: unknown[]) => { messages.push(args); delivered(args); },
	} as unknown as Parameters<typeof interviewExtension>[0]);
	const ctx = {
		hasUI: true,
		hasPendingMessages: () => false,
		cwd: home,
		model: undefined,
		modelRegistry: { find: () => undefined, getAvailable: () => [] },
		ui: { notify: () => {} },
	};
	const questions = JSON.stringify({ questions: [{ id: "q1", type: "text", question: "Name?" }] });
	const result = execute!("call-1", { questions, async: true }, undefined, undefined, ctx);
	return { result, messages, nextMessage, shutdown: () => shutdown!() };
}

it("returns before the user answers and delivers the answer as one turn-triggering message", async ({ onTestFinished }) => {
	const { result, messages, nextMessage, shutdown } = startAsyncInterview();
	onTestFinished(shutdown);
	const started = await result;
	expect(started.details.status).toBe("started");
	expect(messages).toHaveLength(0);

	const url = new URL(started.details.url);
	const interviewId = started.content[0].text.match(/^Interview (\S+) started/)![1];
	const response = await fetch(new URL("/submit", url), {
		method: "POST",
		headers: { "Content-Type": "application/json", Connection: "close" },
		body: JSON.stringify({ token: url.searchParams.get("session"), responses: [{ id: "q1", value: "Ada" }] }),
	});
	expect(response.status).toBe(200);

	const [message, options] = (await nextMessage) as [{ content: string }, unknown];
	expect(message.content).toContain(`Interview ${interviewId} finished.`);
	expect(message.content).toContain("Ada");
	expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
	expect(messages).toHaveLength(1);
});

it("closes outstanding async interviews on session shutdown without sending a message", async () => {
	const { result, messages, shutdown } = startAsyncInterview();
	const started = await result;

	shutdown();

	await expect(fetch(started.details.url, { headers: { Connection: "close" } })).rejects.toThrow();
	expect(messages).toHaveLength(0);
});
