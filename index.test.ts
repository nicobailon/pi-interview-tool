import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInterviewServer, type ResponseItem } from "./server.ts";
import interviewExtension, {
	buildAnsweredAgentResponseItems,
	createGenerateContext,
	extractGenerateResponseText,
	extractJSONArray,
	formatAnsweredResponsesForAgent,
	loadSavedInterview,
	parseGeneratedOptionValues,
	parseOptionInsight,
	parseGeneratedOptions,
	parseReviewedQuestion,
	parseReviewedQuestionUpdate,
	selectGenerateModels,
	buildAskModelsData,
	openLinuxUrl,
	openOrcaUrl,
	shouldAttemptGlimpse,
	describeGlimpseUnavailable,
} from "./index.ts";
import { validateQuestions, type Question } from "./schema.ts";
import { assertValidLauncher, loadSettings } from "./settings.ts";

const fetch: typeof globalThis.fetch = (input, init) => {
	const headers = new Headers(init?.headers);
	headers.set("Connection", "close");
	return globalThis.fetch(input, { ...init, headers });
};

describe("openLinuxUrl", () => {
	const url = "http://127.0.0.1:1234/interview";

	it("tries default launchers in order before the observable fallback", async () => {
		const launches: string[] = [];
		let fallback: { command: string; args: string[]; timeout: number | undefined } | undefined;

		await openLinuxUrl(
			{
				exec: async (command, args, options) => {
					fallback = { command, args, timeout: options?.timeout };
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
			url,
			undefined,
			async (command, args) => {
				launches.push(`${command} ${args.join(" ")}`);
				throw new Error("not available");
			},
		);

		expect(launches).toEqual([
			`xdg-open ${url}`,
			`sensible-browser ${url}`,
			`gio open ${url}`,
		]);
		expect(fallback).toEqual({ command: "xdg-open", args: [url], timeout: 5000 });
	});

	it("uses only the configured browser before its Pi exec fallback", async () => {
		const launches: string[] = [];
		const execs: string[] = [];

		await openLinuxUrl(
			{
				exec: async (command, args) => {
					execs.push(`${command} ${args.join(" ")}`);
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
			url,
			"firefox",
			async (command, args) => {
				launches.push(`${command} ${args.join(" ")}`);
				throw new Error("not available");
			},
		);

		expect(launches).toEqual([`firefox ${url}`]);
		expect(execs).toEqual([`firefox ${url}`]);
	});

	it("uses Pi exec after asynchronous detached launch failures", async () => {
		let usedFallback = false;

		await openLinuxUrl(
			{
				exec: async () => {
					usedFallback = true;
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
			url,
			undefined,
			async () => {
				await Promise.resolve();
				throw new Error("ENOENT");
			},
		);

		expect(usedFallback).toBe(true);
	});

	it("aggregates launcher and killed nonzero Pi exec failures", async () => {
		await expect(
			openLinuxUrl(
				{
					exec: async () => ({
						stdout: "stdout detail",
						stderr: "stderr detail",
						code: 7,
						killed: true,
					}),
				},
				url,
				undefined,
				async (command) => {
					throw new Error(`${command} missing`);
				},
			),
		).rejects.toThrow(
			/xdg-open missing.*sensible-browser missing.*gio missing.*killed \(exit code 7\).*stderr detail.*stdout detail/s,
		);
	});
});

describe("openOrcaUrl", () => {
	const url = "http://127.0.0.1:1234/interview";
	const cwd = "/Users/example/project";

	it("creates and focuses an Orca browser tab in the current worktree", async () => {
		const calls: { command: string; args: string[]; cwd: string | undefined; timeout: number | undefined }[] = [];

		await openOrcaUrl(
			{
				exec: async (command, args, options) => {
					calls.push({ command, args, cwd: options?.cwd, timeout: options?.timeout });
					if (args[1] === "create") {
						return {
							stdout: JSON.stringify({ result: { browserPageId: "page-123" } }),
							stderr: "",
							code: 0,
							killed: false,
						};
					}
					return { stdout: "", stderr: "", code: 0, killed: false };
				},
			},
			url,
			cwd,
		);

		expect(calls).toEqual([
			{
				command: "orca",
				args: ["tab", "create", "--url", url, "--json"],
				cwd,
				timeout: 60_000,
			},
			{
				command: "orca",
				args: ["tab", "switch", "--page", "page-123", "--focus"],
				cwd,
				timeout: undefined,
			},
		]);
	});

	it("rejects a tab creation response without a page id before switching", async () => {
		let calls = 0;
		await expect(openOrcaUrl(
			{
				exec: async () => {
					calls += 1;
					return { stdout: "{}", stderr: "", code: 0, killed: false };
				},
			},
			url,
			cwd,
		)).rejects.toThrow("orca tab create returned no browserPageId: {}");
		expect(calls).toBe(1);
	});

	it("surfaces a tab focus failure", async () => {
		let calls = 0;
		await expect(openOrcaUrl(
			{
				exec: async () => {
					calls += 1;
					return calls === 1
						? {
							stdout: JSON.stringify({ result: { browserPageId: "page-123" } }),
							stderr: "",
							code: 0,
							killed: false,
						}
						: { stdout: "", stderr: "worktree unavailable", code: 1, killed: false };
				},
			},
			url,
			cwd,
		)).rejects.toThrow("orca tab switch: exit code 1: worktree unavailable");
	});
});

describe("shouldAttemptGlimpse", () => {
	it("attempts Glimpse in auto mode and when explicitly selected", () => {
		expect(shouldAttemptGlimpse(undefined, "darwin", false)).toBe(true);
		expect(shouldAttemptGlimpse("glimpse", "darwin", false)).toBe(true);
	});

	it("never attempts Glimpse for the explicit browser and orca launchers", () => {
		expect(shouldAttemptGlimpse("browser", "darwin", false)).toBe(false);
		expect(shouldAttemptGlimpse("orca", "darwin", false)).toBe(false);
	});

	it("skips Glimpse off macOS and in remote sessions", () => {
		expect(shouldAttemptGlimpse(undefined, "linux", false)).toBe(false);
		expect(shouldAttemptGlimpse("glimpse", "darwin", true)).toBe(false);
	});
});

describe("assertValidLauncher", () => {
	it("accepts an absent setting and every supported launcher", () => {
		expect(() => assertValidLauncher(undefined)).not.toThrow();
		expect(() => assertValidLauncher("glimpse")).not.toThrow();
		expect(() => assertValidLauncher("browser")).not.toThrow();
		expect(() => assertValidLauncher("orca")).not.toThrow();
	});

	it("rejects unsupported values instead of silently selecting auto behavior", () => {
		expect(() => assertValidLauncher("orc")).toThrow(
			'interview.launcher must be one of: glimpse, browser, orca (received "orc")',
		);
		expect(() => assertValidLauncher(null)).toThrow("(received null)");
	});
});

describe("loadSettings", () => {
	function writeSettings(interview: unknown): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-interview-settings-"));
		const file = join(dir, "settings.json");
		writeFileSync(file, JSON.stringify({ interview }));
		return file;
	}

	it("reads interview settings and rejects an unsupported launcher", () => {
		expect(loadSettings(writeSettings({ launcher: "orca", timeout: 90 }))).toMatchObject({
			launcher: "orca",
			timeout: 90,
		});
		expect(() => loadSettings(writeSettings({ launcher: "orc" }))).toThrow(
			"interview.launcher must be one of: glimpse, browser, orca",
		);
	});

	it("returns empty settings when the file is missing", () => {
		expect(loadSettings(join(tmpdir(), "pi-interview-settings-missing", "settings.json"))).toEqual({});
	});
});

describe("describeGlimpseUnavailable", () => {
	it("prefers a captured failure over the generic causes", () => {
		expect(describeGlimpseUnavailable("glimpseui import: boom", "darwin", false)).toBe(
			"Glimpse launcher unavailable: glimpseui import: boom",
		);
	});

	it("distinguishes platform, remote session, and missing package causes", () => {
		expect(describeGlimpseUnavailable(null, "linux", false)).toBe(
			"Glimpse launcher unavailable: requires macOS",
		);
		expect(describeGlimpseUnavailable(null, "darwin", true)).toBe(
			"Glimpse launcher unavailable: skipped for remote ssh/mosh sessions",
		);
		expect(describeGlimpseUnavailable(null, "darwin", false)).toBe(
			"Glimpse launcher unavailable: install the glimpseui package",
		);
	});
});

describe("selectGenerateModels", () => {
	const configured = { provider: "anthropic", id: "claude-haiku-4-5" };
	const current = { provider: "openai", id: "gpt-5.4" };
	const available = [
		{ provider: "google", id: "gemini-2.5-flash" },
		{ provider: "openai", id: "gpt-4.1-mini" },
	];

	it("uses the configured model first and current model as fallback", () => {
		const result = selectGenerateModels(configured, current, available);
		expect(result).toEqual({ primary: configured, fallback: current });
	});

	it("uses the current model when no configured model is set", () => {
		const result = selectGenerateModels(null, current, available);
		expect(result).toEqual({ primary: current, fallback: null });
	});

	it("uses the preferred available model when neither configured nor current is set", () => {
		const result = selectGenerateModels(null, null, available);
		expect(result).toEqual({ primary: available[0], fallback: null });
	});

	it("does not set a fallback when configured and current are the same model", () => {
		const result = selectGenerateModels(configured, configured, available);
		expect(result).toEqual({ primary: configured, fallback: null });
	});
});

describe("buildAskModelsData", () => {
	it("limits Ask choices to current/default/fallback and preferred safe alternatives", () => {
		const current = { provider: "openai-codex", id: "gpt-5.4" };
		const primary = { provider: "openai-codex", id: "gpt-5.4" };
		const fallback = { provider: "anthropic", id: "claude-haiku-4-5" };
		const available = [
			{ provider: "openai-codex", id: "gpt-5.1-codex-mini" },
			{ provider: "openai-codex", id: "gpt-5.4" },
			{ provider: "anthropic", id: "claude-haiku-4-5" },
			{ provider: "google", id: "gemini-2.5-flash" },
			{ provider: "openrouter", id: "some-random-model" },
		];

		expect(buildAskModelsData(available, current, primary, fallback)).toEqual([
			{ value: "openai-codex/gpt-5.4", provider: "openai-codex", label: "gpt-5.4" },
			{ value: "anthropic/claude-haiku-4-5", provider: "anthropic", label: "claude-haiku-4-5" },
			{ value: "google/gemini-2.5-flash", provider: "google", label: "gemini-2.5-flash" },
		]);
	});
});

describe("extractGenerateResponseText", () => {
	it("surfaces provider errors instead of reporting an empty response", () => {
		expect(() =>
			extractGenerateResponseText("anthropic/claude-haiku-4-5", {
				stopReason: "error",
				errorMessage: "You have exceeded your Anthropic usage limit",
				content: [],
			}),
		).toThrow("anthropic/claude-haiku-4-5: You have exceeded your Anthropic usage limit");
	});

	it("throws when the model returns no text blocks", () => {
		expect(() =>
			extractGenerateResponseText("openai/gpt-5.4", {
				stopReason: "stop",
				content: [],
			}),
		).toThrow("openai/gpt-5.4 returned no text response");
	});
});

describe("extractJSONArray", () => {
	it("keeps brackets inside quoted strings while extracting the array", () => {
		const text = 'Here you go: ["React [recommended]", "Vue"] trailing note';
		expect(extractJSONArray(text)).toBe('["React [recommended]", "Vue"]');
	});
});

describe("createGenerateContext", () => {
	it("always includes a non-empty system prompt for providers that require instructions", () => {
		const context = createGenerateContext("Review these options");
		expect(context.systemPrompt).toContain("Return only a JSON array of strings");
		expect(context.messages[0].content[0].text).toBe("Review these options");
	});

	it("allows review mode to supply a different system prompt", () => {
		const context = createGenerateContext("Review this question", "Custom review prompt");
		expect(context.systemPrompt).toBe("Custom review prompt");
	});
});

describe("parseGeneratedOptions", () => {
	it("trims valid strings and drops empty items", () => {
		expect(parseGeneratedOptions('[" React ", "", "Vue"]')).toEqual(["React", "Vue"]);
	});

	it("preserves the parse error context", () => {
		expect(() => parseGeneratedOptions('not json')).toThrow("Failed to parse generated options:");
	});
});

describe("parseGeneratedOptionValues", () => {
	it("parses mixed generated option values for rich-option questions", () => {
		expect(
			parseGeneratedOptionValues('["Fast path",{"label":"Guided path","content":{"source":"Explain tradeoffs","lang":"md"}}]'),
		).toEqual([
			"Fast path",
			{ label: "Guided path", content: { source: "Explain tradeoffs", lang: "md" } },
		]);
	});

	it("preserves the parse error context", () => {
		expect(() => parseGeneratedOptionValues('not json')).toThrow("Failed to parse generated options:");
	});

	it("allows duplicate labels to reach server-side reconciliation", () => {
		expect(
			parseGeneratedOptionValues('["Fast path",{"label":"Fast path","content":{"source":"Keep the richer version","lang":"md"}}]'),
		).toEqual([
			"Fast path",
			{ label: "Fast path", content: { source: "Keep the richer version", lang: "md" } },
		]);
	});
});

describe("parseReviewedQuestion", () => {
	it("parses a rewritten question and reviewed options from a JSON object", () => {
		expect(
			parseReviewedQuestion('{"question":"Clearer prompt","options":["A","B"]}'),
		).toEqual({ question: "Clearer prompt", options: ["A", "B"] });
	});

	it("preserves the parse error context", () => {
		expect(() => parseReviewedQuestion('not json')).toThrow("Failed to parse reviewed question:");
	});
});

describe("parseReviewedQuestionUpdate", () => {
	it("parses a rewritten question with rich option objects", () => {
		expect(
			parseReviewedQuestionUpdate('{"question":"Clearer prompt","options":[{"label":"A","content":{"source":"Alpha","lang":"md"}},{"label":"B"}]}'),
		).toEqual({
			question: "Clearer prompt",
			options: [
				{ label: "A", content: { source: "Alpha", lang: "md" } },
				{ label: "B" },
			],
		});
	});
});

describe("parseOptionInsight", () => {
	it("parses structured option insight JSON", () => {
		expect(
			parseOptionInsight('{"summary":"Fast to ship","bullets":["Low complexity","Easy to explain"],"suggestedText":"Use Redis cache"}'),
		).toEqual({
			summary: "Fast to ship",
			bullets: ["Low complexity", "Easy to explain"],
			suggestedText: "Use Redis cache",
		});
	});

	it("preserves parse error context", () => {
		expect(() => parseOptionInsight("not json")).toThrow("Failed to parse option insight:");
	});
});

describe("agent-facing interview response formatting", () => {
	const questions: Question[] = [
		{ id: "scope", type: "multi", question: "Which areas should the compactness plan target first?", options: ["Tool overrides", "Vendored modal stack", "README"] },
		{ id: "risk", type: "single", question: "How aggressive should the plan be?", options: ["Conservative", "Moderate"] },
		{ id: "constraints", type: "text", question: "Any extra constraints for the plan?" },
		{ id: "mockup", type: "image", question: "Attach supporting screenshots" },
	];

	it("uses full question text, omits unanswered items, and preserves structured JSON", () => {
		const responses: ResponseItem[] = [
			{ id: "scope", value: [{ option: "Tool overrides" }, { option: "Vendored modal stack", note: "Only if import path cleanup is simple" }] },
			{ id: "risk", value: { option: "Moderate" } },
			{ id: "constraints", value: "Avoid changing public docs." },
			{ id: "mockup", value: "" },
		];

		const text = formatAnsweredResponsesForAgent(responses, questions);

		expect(text).toContain("- Which areas should the compactness plan target first?: Tool overrides, Vendored modal stack (Only if import path cleanup is simple)");
		expect(text).toContain("- How aggressive should the plan be?: Moderate");
		expect(text).toContain("- Any extra constraints for the plan?: Avoid changing public docs.");
		expect(text).not.toContain("scope:");
		expect(text).not.toContain("Attach supporting screenshots");
		expect(text).toContain("```json");
		expect(text).toContain('"question": "Which areas should the compactness plan target first?"');
		expect(text).toContain('"note": "Only if import path cleanup is simple"');
	});

	it("treats attachment-only and image responses as answered content", () => {
		const responses: ResponseItem[] = [
			{ id: "constraints", value: "", attachments: ["/tmp/spec.pdf"] },
			{ id: "mockup", value: ["/tmp/mock-1.png", "/tmp/mock-2.png"] },
		];

		const items = buildAnsweredAgentResponseItems(responses, questions);
		const text = formatAnsweredResponsesForAgent(responses, questions);

		expect(items).toEqual([
			{
				id: "constraints",
				question: "Any extra constraints for the plan?",
				type: "text",
				value: "",
				attachments: ["/tmp/spec.pdf"],
			},
			{
				id: "mockup",
				question: "Attach supporting screenshots",
				type: "image",
				value: ["/tmp/mock-1.png", "/tmp/mock-2.png"],
			},
		]);
		expect(text).toContain("- Any extra constraints for the plan?: 1 attachment included [attachments: /tmp/spec.pdf]");
		expect(text).toContain("- Attach supporting screenshots: 2 images attached");
		const jsonBlock = text.match(/```json\n([\s\S]*?)\n```/);
		expect(jsonBlock?.[1]).toBeTruthy();
		expect(JSON.parse(jsonBlock![1])).toEqual(items);
	});

	it("keeps the compactness-plan answers visible in the agent payload for the screenshot-shaped case", () => {
		const questions: Question[] = [
			{
				id: "scope",
				type: "multi",
				question: "Which areas should the compactness plan target first?",
				options: [
					"`src/tool-overrides.ts` monolith",
					"Vendored modal stack (`src/zellij-modal.ts`, settings UI)",
					"Small utility dedupes (`pluralize`, line splitting/counting, preview helpers)",
					"README / config surface trimming if code no longer needs it",
					"`src/multi-edit.ts` itself",
				],
			},
			{
				id: "risk",
				type: "single",
				question: "How aggressive should the plan be?",
				options: ["Conservative", "Moderate", "Aggressive"],
			},
			{
				id: "vendor",
				type: "single",
				question: "What should the plan assume about the vendored `zellij-modal.ts`?",
				options: [
					"Keep vendored; only trim local wrappers around it",
					"Open to replacing vendored code with shared dependency/use-site import if feasible",
					"Undecided - include both options with tradeoffs",
				],
			},
			{
				id: "output",
				type: "single",
				question: "What kind of plan do you want?",
				options: [
					"Execution plan: ordered phases, concrete edits, validation steps, and stop points",
					"Architecture memo: critique plus options, no implementation sequence",
					"Short tactical checklist only",
				],
			},
			{
				id: "constraints",
				type: "text",
				question: "Any extra constraints for the plan?",
			},
		];

		const responses: ResponseItem[] = [
			{
				id: "scope",
				value: [
					{ option: "`src/tool-overrides.ts` monolith" },
					{ option: "Vendored modal stack (`src/zellij-modal.ts`, settings UI)" },
				],
			},
			{ id: "risk", value: { option: "Moderate" } },
			{ id: "vendor", value: { option: "Open to replacing vendored code with shared dependency/use-site import if feasible" } },
			{ id: "output", value: { option: "Execution plan: ordered phases, concrete edits, validation steps, and stop points" } },
			{ id: "constraints", value: "" },
		];

		const text = formatAnsweredResponsesForAgent(responses, questions);

		expect(text).toContain("- Which areas should the compactness plan target first?: `src/tool-overrides.ts` monolith, Vendored modal stack (`src/zellij-modal.ts`, settings UI)");
		expect(text).toContain("- How aggressive should the plan be?: Moderate");
		expect(text).toContain("- What should the plan assume about the vendored `zellij-modal.ts`?: Open to replacing vendored code with shared dependency/use-site import if feasible");
		expect(text).toContain("- What kind of plan do you want?: Execution plan: ordered phases, concrete edits, validation steps, and stop points");
		expect(text).not.toContain("- scope:");
		expect(text).not.toContain("- constraints:");
	});
});

describe("loadSavedInterview", () => {
	it("resolves only image and attachment paths while keeping literal answers unchanged", () => {
		const html = `<!doctype html><html><body>
		<script type="application/json" id="pi-interview-data">${JSON.stringify({
			title: "Saved",
			questions: [
				{ id: "framework", type: "single", question: "Framework?", options: ["React", "Vue"] },
				{ id: "notes", type: "text", question: "Notes?" },
				{ id: "mockup", type: "image", question: "Mockup" },
			],
			savedAnswers: [
				{ id: "framework", value: "React", attachments: ["images/decision.png"] },
				{ id: "notes", value: "Use edge runtime" },
				{ id: "mockup", value: "images/mock.png" },
			],
		})}</script>
		</body></html>`;

		const snapshotPath = "/tmp/pi-interview-snapshot/index.html";
		const loaded = loadSavedInterview(html, snapshotPath);
		const answers = loaded.savedAnswers ?? [];

		expect(answers[0]?.value).toBe("React");
		expect(answers[0]?.attachments).toEqual([join("/tmp/pi-interview-snapshot", "images/decision.png")]);
		expect(answers[1]?.value).toBe("Use edge runtime");
		expect(answers[2]?.value).toBe(join("/tmp/pi-interview-snapshot", "images/mock.png"));
	});

	it("loads saved option insights and option keys when present", () => {
		const html = `<!doctype html><html><body>
		<script type="application/json" id="pi-interview-data">${JSON.stringify({
			title: "Saved",
			questions: [
				{ id: "framework", type: "single", question: "Framework?", options: ["React", "Vue"] },
			],
			savedOptionInsights: [
				{
					id: "insight-1",
					questionId: "framework",
					optionKey: "opt-1",
					optionText: "React",
					prompt: "Why this option?",
					summary: "Fastest path for this stack",
					bullets: ["Strong team familiarity"],
				},
			],
			optionKeysByQuestion: { framework: ["opt-1", "opt-2"] },
		})}</script>
		</body></html>`;

		const loaded = loadSavedInterview(html, "/tmp/pi-interview-snapshot/index.html");
		expect(loaded.savedOptionInsights?.[0]?.summary).toBe("Fastest path for this stack");
		expect(loaded.optionKeysByQuestion).toEqual({ framework: ["opt-1", "opt-2"] });
	});

	it("loads structured choice answers from saved interviews", () => {
		const html = `<!doctype html><html><body>
		<script type="application/json" id="pi-interview-data">${JSON.stringify({
			title: "Saved",
			questions: [
				{ id: "framework", type: "single", question: "Framework?", options: ["React", "Vue"] },
				{ id: "priorities", type: "multi", question: "Priorities?", options: ["Speed", "Clarity"] },
			],
			savedAnswers: [
				{ id: "framework", value: { option: "React", note: "For internal tools only" } },
				{ id: "priorities", value: [{ option: "Speed" }, { option: "Clarity", note: "Docs matter too" }] },
			],
		})}</script>
		</body></html>`;

		const loaded = loadSavedInterview(html, "/tmp/pi-interview-snapshot/index.html");
		expect(loaded.savedAnswers?.[0]?.value).toEqual({ option: "React", note: "For internal tools only" });
		expect(loaded.savedAnswers?.[1]?.value).toEqual([
			{ option: "Speed" },
			{ option: "Clarity", note: "Docs matter too" },
		]);
	});
});

describe("privacy-safe camera capture", () => {
		it("keeps camera activation explicit and routes stills through normal image validation", () => {
			const clientSource = readFileSync("form/script.js", "utf-8");

			expect(clientSource).toContain('button.textContent = "Use camera";');
			expect(clientSource).toContain('class="btn-primary camera-start-btn">Start camera</button>');
			expect(clientSource).toContain('navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })');
			expect(clientSource).toContain('new File([blob], `camera-${stamp}.jpg`');
			expect(clientSource).toContain("await checkImageFile(operation.target.questionId, operation.file)");
			expect(clientSource).toContain("operation.target.manager.addFile(operation.target.questionId, operation.file)");
			expect(clientSource).toContain("createCameraButton(question.id, questionImages)");
			expect(clientSource).toContain("createCameraButton(question.id, attachments");
			expect(clientSource).toContain("if (!window.isSecureContext)");
			expect(clientSource).toContain("cameraCaptureState.selectedDeviceId = selected?.deviceId || \"\";");
			expect(clientSource).toContain("captureBtn.focus();");
			expect(clientSource).toContain("void populateCameraDevices();");
			expect(clientSource).toContain("Choose Switch camera to apply it.");
			expect(clientSource).toContain("} else if (isCameraButton(option)) {\n            option.click();");
		});

		it("stops camera tracks on stale requests and every page/session teardown path", () => {
			const clientSource = readFileSync("form/script.js", "utf-8");
			const teardownCalls = clientSource.match(/closeCameraCapture\(\{ restoreFocus: false \}\);/g) ?? [];

			expect(clientSource).toContain("stream.getTracks().forEach((track) => track.stop());");
			expect(clientSource).toContain("requestId !== cameraCaptureState.requestId");
			expect(clientSource).toContain("if (!isCurrentCameraOperation(operation)) return;");
			expect(clientSource).toContain("useBtn.disabled = true;");
			expect(clientSource).toContain("retakeBtn.disabled = true;");
			expect(clientSource).toContain("operation.file !== cameraCaptureState.pendingFile");
			expect(clientSource).toContain("function retakeCameraFrame() {\n    const overlay = cameraCaptureState.overlay;\n    if (!overlay || !cameraCaptureState.stream) return;\n    cameraCaptureState.requestId += 1;");
			expect(teardownCalls.length).toBeGreaterThanOrEqual(7);
			expect(clientSource).toContain('window.addEventListener("pagehide", (event) => {\n      closeCameraCapture({ restoreFocus: false });');
		});

		it("uses an accessible responsive dialog with existing design tokens", () => {
			const clientSource = readFileSync("form/script.js", "utf-8");
			const styles = readFileSync("form/styles.css", "utf-8");

			expect(clientSource).toContain('role="dialog" aria-modal="true"');
			expect(clientSource).toContain('class="camera-capture-status" role="status" aria-live="polite"');
			expect(clientSource).toContain("trapCameraFocus(event, dialog)");
			expect(styles).toMatch(/\.camera-capture-dialog \{[^}]*background: var\(--bg-card\);[^}]*border: 1px solid var\(--border-focus\);/s);
			expect(styles).toContain("@media (max-width: 640px)");
		});
});

describe("content rendering styles", () => {
	it("wraps long lines in live interview code blocks", () => {
		const styles = readFileSync("form/styles.css", "utf-8");
		expect(styles).toMatch(/\.code-block pre \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s);
		expect(styles).toMatch(/\.code-block code \{[^}]*white-space: inherit;[^}]*overflow-wrap: inherit;[^}]*word-break: inherit;/s);
	});

	it("wraps long lines in saved interview snapshots", () => {
		const serverSource = readFileSync("server.ts", "utf-8");
		expect(serverSource).toMatch(/\.saved-code \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/s);
	});

	it("defaults markdown content to preview unless showSource is true", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		const serverSource = readFileSync("server.ts", "utf-8");
		expect(clientSource).toContain("const markdownPreview = isMarkdownLang(block.lang) && block.showSource !== true;");
		expect(serverSource).toContain("const markdownPreview = isMarkdownLang(content.lang) && content.showSource !== true;");
	});

	it("includes the option-body alignment, selection, and clarification input styles", () => {
		const styles = readFileSync("form/styles.css", "utf-8");
		expect(styles).toMatch(/\.option-item-label \{[^}]*align-items: center;/s);
		expect(styles).toMatch(/\.option-item \{[^}]*user-select: text;/s);
		expect(styles).toMatch(/\.option-item-body \{[^}]*cursor: text;[^}]*user-select: text;/s);
		expect(styles).toMatch(/\.option-item input\[type="radio"\],\s*\.option-item input\[type="checkbox"\] \{[^}]*cursor: pointer;[^}]*user-select: none;/s);
		expect(styles).toMatch(/input\[type="radio"\],\s*input\[type="checkbox"\] \{[^}]*margin-top: 2px;/s);
		expect(styles).toContain(".option-note-input");
		expect(styles).toContain("background-image: radial-gradient(circle, var(--accent) 0 45%, transparent 55%);");
		expect(styles).toContain("input[type=\"radio\"]:checked {");
		expect(styles).not.toContain("input[type=\"radio\"]::before");
	});

	it("uses selectable option rows and Cmd-arrow question navigation", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain('const item = document.createElement("div");');
		expect(clientSource).toContain('item.addEventListener("click", (event) => {');
		expect(clientSource).toContain("window.getSelection()");
		expect(clientSource).toContain('function isQuestionNavShortcut(event, direction)');
		expect(clientSource).toContain('const modPressed = isMac ? event.metaKey : event.ctrlKey;');
		expect(clientSource).toContain('return event.key === key && modPressed && !otherModPressed && !event.altKey && !event.shiftKey;');
		expect(clientSource).not.toContain("function setupEdgeNavigation");
	});

	it("lets text clipboard data win inside focused editable controls", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain("function handlePaste(event)");
		expect(clientSource).toContain("if (!isEditableTextControl(active)) return;");
		expect(clientSource).toContain('const text = event.clipboardData?.getData("text/plain");');
		expect(clientSource).toContain('if (typeof text !== "string" || text.length === 0) return;');
		expect(clientSource).toContain("event.preventDefault();\n    event.stopPropagation();");
		expect(clientSource).toContain('active.setRangeText(text, start, end, "end");');
		expect(clientSource).toContain('active.dispatchEvent(new Event("input", { bubbles: true }));');
		expect(clientSource).not.toContain("function insertTextAtSelection");
		expect(clientSource).toContain('document.addEventListener("paste", handlePaste, true);');
	});

	it("keeps Ask results saved by default without extra mutation actions", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain("function saveActiveInsight(question, optionKey, optionText)");
		expect(clientSource).toContain("saveActiveInsight(question, optionKey, optionText);");
		expect(clientSource).toContain("const nextValue = preserveChoiceAnswerValue(question, currentValue, revisedLabels);");
		expect(clientSource).not.toContain("runOptionAction");
		expect(clientSource).not.toContain("Move up");
		expect(clientSource).not.toContain("Use rewrite");
		expect(clientSource).not.toContain("Add rewrite as option");
		expect(clientSource).not.toContain('textContent = "Pin"');
		expect(clientSource).not.toContain('textContent = "Unpin"');
	});

	it("keeps deselected clarification drafts across option rerenders", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain("populateQuestion(question, { [question.id]: value }, { preserveChoiceNotes: true });");
		expect(clientSource).toContain("function populateQuestion(question, saved, options = {})");
		expect(clientSource).toContain("if (!hasSavedValue) return;");
		expect(clientSource).toContain("if (!preserveChoiceNotes) {\n        clearChoiceNotes(question.id);\n      }");
		expect(clientSource).toContain("questions.forEach((question) => {\n      populateQuestion(question, saved, options);\n    });");
	});

	it("preserves FileReader error details when upload encoding fails", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain('reject(new Error(reader.error?.message || "Failed to read file"));');
		expect(clientSource).toContain('reject(new Error(`Failed to read file: unexpected FileReader result type ${typeof reader.result}`));');
	});
});

describe("tool registration", () => {
	it("registers a promptSnippet so the tool appears in default tool prompts", () => {
		let registeredTool: Record<string, unknown> | undefined;
		interviewExtension({ registerTool: (tool: Record<string, unknown>) => { registeredTool = tool; } } as unknown as Parameters<typeof interviewExtension>[0]);

		expect(registeredTool).toBeDefined();
		expect(typeof registeredTool?.promptSnippet).toBe("string");
		expect((registeredTool?.promptSnippet as string).length).toBeGreaterThan(0);
	});
});

describe("server binding", () => {
	it("scans forward when the first low port is already in use", async () => {
		const first = await startInterviewServer(
			{
				questions: { title: "First", questions: [{ id: "q", type: "text", question: "Q?" }] },
				sessionToken: "first-token",
				sessionId: "first-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		try {
			const second = await startInterviewServer(
				{
					questions: { title: "Second", questions: [{ id: "q", type: "text", question: "Q?" }] },
					sessionToken: "second-token",
					sessionId: "second-session",
					cwd: process.cwd(),
					timeout: 600,
				},
				{ onSubmit: () => {}, onCancel: () => {} },
			);
			try {
				expect(second.port).not.toBe(first.port);
				expect(second.port).toBeGreaterThanOrEqual(8377);
				expect(second.port).toBeLessThanOrEqual(8396);
			} finally {
				second.close();
			}
		} finally {
			first.close();
		}
	});
});

describe("image upload boundaries", () => {
	it("accepts camera-named JPEGs as image answers and attachments", async () => {
		const sessionId = `camera-upload-${process.pid}-${Date.now()}`;
		const bytes = Buffer.from(
			"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVL//2Q==",
			"base64",
		);
		expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
		let resolveSubmitted!: (responses: ResponseItem[]) => void;
		const submitted = new Promise<ResponseItem[]>((resolve) => {
			resolveSubmitted = resolve;
		});
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Camera transport",
					questions: [
						{ id: "photo", type: "image", question: "Take a photo" },
						{ id: "notes", type: "text", question: "Notes" },
					],
				},
				sessionToken: "camera-upload-token",
				sessionId,
				cwd: process.cwd(),
				timeout: 600,
			},
			{ onSubmit: resolveSubmitted, onCancel: () => {} },
		);

		try {
			const response = await fetch(new URL("/submit", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "camera-upload-token",
					responses: [
						{ id: "photo", value: "" },
						{ id: "notes", value: "Physical evidence" },
					],
					images: [
						{ id: "photo", filename: "camera-panel.jpg", mimeType: "image/jpeg", data: bytes.toString("base64") },
						{ id: "notes", filename: "camera-context.jpg", mimeType: "image/jpeg", data: bytes.toString("base64"), isAttachment: true },
					],
				}),
			});
			expect(response.status).toBe(200);

			const responses = await submitted;
			const photoValue = responses.find((item) => item.id === "photo")?.value;
			const attachmentPath = responses.find((item) => item.id === "notes")?.attachments?.[0];
			expect(typeof photoValue).toBe("string");
			expect(attachmentPath).toBeTruthy();
			expect(readFileSync(photoValue as string)).toEqual(bytes);
			expect(readFileSync(attachmentPath!)).toEqual(bytes);
		} finally {
			handle.close();
			rmSync(join(tmpdir(), `pi-interview-${sessionId}`), { recursive: true, force: true });
		}
	});

	it.each(["/submit", "/save"])("rejects non-attachment images for choice questions on %s", async (pathname) => {
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Image boundary",
					questions: [{ id: "choice", type: "single", question: "Pick one", options: ["A"] }],
				},
				sessionToken: "image-boundary-token",
				sessionId: `image-boundary-${pathname.slice(1)}`,
				cwd: process.cwd(),
				timeout: 600,
			},
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		try {
			const response = await fetch(new URL(pathname, handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "image-boundary-token",
					responses: [{ id: "choice", value: { option: "A" } }],
					images: [{ id: "choice", filename: "test.png", mimeType: "image/png", data: "" }],
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(400);
			expect(result).toMatchObject({ error: "Image uploads require an image question", field: "choice" });
		} finally {
			handle.close();
		}
	});
});

describe("rich option question flows", () => {
	it("shows clarification fields for rich-option questions too", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain("questionSupportsOptionInsights(question) || !isSelected");
		expect(clientSource).not.toContain('question.options.every((option) => typeof option === "string")');
	});

	it("saves structured choice notes into the snapshot HTML", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "pi-interview-choice-note-"));
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Choice notes",
					questions: [
						{
							id: "framework",
							type: "single",
							question: "Framework?",
							options: [
								{ label: "React", content: { source: "Use the React app shell.", lang: "md" } },
								{ label: "Vue", content: { source: "Ship a smaller Vue surface.", lang: "md" } },
							],
						},
					],
				},
				sessionToken: "choice-note-token",
				sessionId: "choice-note-session",
				cwd: process.cwd(),
				timeout: 600,
				snapshotDir,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
			},
		);

		try {
			const response = await fetch(new URL("/save", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "choice-note-token",
					responses: [
						{ id: "framework", value: { option: "React", note: "For internal tools only" } },
					],
				}),
			});
			const result = await response.json();
			const savedHtml = readFileSync(join(result.path, "index.html"), "utf-8");

			expect(response.status).toBe(200);
			expect(savedHtml).toContain("For internal tools only");
		} finally {
			handle.close();
			rmSync(snapshotDir, { recursive: true, force: true });
		}
	});

	it("generates more options for rich-option questions", async () => {
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Rich Generate",
					questions: [
						{
							id: "policy",
							type: "single",
							question: "Pick one",
							options: [
								{ label: "Show nothing", content: { source: "No suggestion is better than a misleading one.", lang: "md" } },
							],
						},
					],
				},
				sessionToken: "rich-generate-token",
				sessionId: "rich-generate-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onGenerate: async () => ({
					options: [
						"Fallback to history",
						{ label: "Ask for clarification", content: { source: "Prompt for missing context first.", lang: "md" } },
					],
				}),
			},
		);

		try {
			const html = await (await fetch(handle.url)).text();
			const inlineDataMatch = html.match(/window\.__INTERVIEW_DATA__ = (\{[\s\S]*?\});/);
			expect(inlineDataMatch?.[1]).toBeTruthy();
			const bootData = JSON.parse(inlineDataMatch![1]);

			const response = await fetch(new URL("/generate", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "rich-generate-token",
					questionId: "policy",
					existingOptions: ["Show nothing"],
					mode: "add",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.options).toEqual([
				"Fallback to history",
				{ label: "Ask for clarification", content: { source: "Prompt for missing context first.", lang: "md" } },
			]);
			expect(result.optionKeys).toHaveLength(3);
			expect(result.optionKeys[0]).toBe(bootData.optionKeysByQuestion.policy[0]);
		} finally {
			handle.close();
		}
	});

	it("does not trust stale client option lists when deduping generated options", async () => {
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Rich Generate",
					questions: [
						{
							id: "policy",
							type: "single",
							question: "Pick one",
							options: [
								{ label: "Show nothing", content: { source: "No suggestion is better than a misleading one.", lang: "md" } },
							],
						},
					],
				},
				sessionToken: "rich-generate-stale-token",
				sessionId: "rich-generate-stale-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onGenerate: async () => ({
					options: ["Show nothing"],
				}),
			},
		);

		try {
			const response = await fetch(new URL("/generate", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "rich-generate-stale-token",
					questionId: "policy",
					existingOptions: [],
					mode: "add",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.options).toEqual([]);
			expect(result.optionKeys).toHaveLength(1);
		} finally {
			handle.close();
		}
	});

	it("reviews rich-option questions without flattening them and preserves surviving keys", async () => {
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Rich Review",
					questions: [
						{
							id: "policy",
							type: "single",
							question: "Pick one",
							options: [
								{ label: "Show nothing", content: { source: "No suggestion is better than a misleading one.", lang: "md" } },
								{ label: "Fallback to history", content: { source: "Use local successful history as a trusted backup.", lang: "md" } },
							],
						},
					],
				},
				sessionToken: "rich-review-token",
				sessionId: "rich-review-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onGenerate: async () => ({
					question: "What should happen when there is not enough context?",
					options: [
						{ label: "Fallback to history", content: { source: "Use local successful history as a trusted backup.", lang: "md" } },
						{ label: "Ask for clarification", content: { source: "Prompt for missing context first.", lang: "md" } },
					],
				}),
			},
		);

		try {
			const html = await (await fetch(handle.url)).text();
			const inlineDataMatch = html.match(/window\.__INTERVIEW_DATA__ = (\{[\s\S]*?\});/);
			expect(inlineDataMatch?.[1]).toBeTruthy();
			const bootData = JSON.parse(inlineDataMatch![1]);

			const response = await fetch(new URL("/generate", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "rich-review-token",
					questionId: "policy",
					existingOptions: ["Show nothing", "Fallback to history"],
					mode: "review",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.question).toBe("What should happen when there is not enough context?");
			expect(result.options).toEqual([
				{ label: "Fallback to history", content: { source: "Use local successful history as a trusted backup.", lang: "md" } },
				{ label: "Ask for clarification", content: { source: "Prompt for missing context first.", lang: "md" } },
			]);
			expect(result.optionKeys).toHaveLength(2);
			expect(result.optionKeys[0]).toBe(bootData.optionKeysByQuestion.policy[1]);
			expect(result.optionKeys[1]).not.toBe(bootData.optionKeysByQuestion.policy[0]);
		} finally {
			handle.close();
		}
	});

	it("preserves recommendations when review normalizes an option label", async () => {
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Recommendation review",
					questions: [
						{
							id: "focus",
							type: "single",
							question: "What should we tackle first?",
							options: ["  Keep current shape  ", "Alternative"],
							recommended: "  Keep current shape  ",
						},
					],
				},
				sessionToken: "recommendation-review-token",
				sessionId: "recommendation-review-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onGenerate: async () => ({
					question: "What should we tackle first?",
					options: ["Keep current shape", "Alternative", "New idea"],
				}),
			},
		);

		try {
			const response = await fetch(new URL("/generate", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "recommendation-review-token",
					questionId: "focus",
					mode: "review",
				}),
			});
			expect(response.status).toBe(200);

			const html = await (await fetch(handle.url)).text();
			const inlineDataMatch = html.match(/window\.__INTERVIEW_DATA__ = (\{[\s\S]*?\});/);
			expect(inlineDataMatch?.[1]).toBeTruthy();
			const bootData = JSON.parse(inlineDataMatch![1]);
			expect(bootData.questions[0]?.recommended).toBe("Keep current shape");
		} finally {
			handle.close();
		}
	});

	it("normalizes option-level recommendations into the browser boot payload", async () => {
		const handle = await startInterviewServer(
			{
				questions: validateQuestions({
					title: "Option-level recommendations",
					questions: [
						{
							id: "scope",
							type: "multi",
							question: "What should we include?",
							options: [
								{ label: "Workspace files", recommended: true, conviction: "strong" },
								{ label: "Ignored files" },
								{ label: "Build output", recommended: true },
							],
						},
					],
				}),
				sessionToken: "option-level-recommendation-token",
				sessionId: "option-level-recommendation-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
			},
		);

		try {
			const html = await (await fetch(handle.url)).text();
			const inlineDataMatch = html.match(/window\.__INTERVIEW_DATA__ = (\{[\s\S]*?\});/);
			expect(inlineDataMatch?.[1]).toBeTruthy();
			const bootData = JSON.parse(inlineDataMatch![1]);
			expect(bootData.questions[0]?.recommended).toEqual(["Workspace files", "Build output"]);
			expect(bootData.questions[0]?.conviction).toBe("strong");
		} finally {
			handle.close();
		}
	});

	it("keeps the richer duplicate when generated options repeat a label", async () => {
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Rich Generate",
					questions: [
						{
							id: "policy",
							type: "single",
							question: "Pick one",
							options: ["Existing option"],
						},
					],
				},
				sessionToken: "rich-generate-duplicate-token",
				sessionId: "rich-generate-duplicate-session",
				cwd: process.cwd(),
				timeout: 600,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onGenerate: async () => ({
					options: [
						"Fast path",
						{ label: "Fast path", content: { source: "Keep this richer explanation", lang: "md" } },
					],
				}),
			},
		);

		try {
			const response = await fetch(new URL("/generate", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "rich-generate-duplicate-token",
					questionId: "policy",
					existingOptions: ["Existing option"],
					mode: "add",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.options).toEqual([
				{ label: "Fast path", content: { source: "Keep this richer explanation", lang: "md" } },
			]);
		} finally {
			handle.close();
		}
	});

	it("accepts option insight requests for rich options", async () => {
		let seenOption: unknown;
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Rich Ask",
					questions: [
						{
							id: "policy",
							type: "single",
							question: "Pick one",
							options: [
								{ label: "Show nothing", content: { source: "No suggestion is better than a misleading one.", lang: "md" } },
								{ label: "Fallback to history", content: { source: "Use local successful history as a trusted backup.", lang: "md" } },
							],
						},
					],
				},
				sessionToken: "rich-option-token",
				sessionId: "rich-option-session",
				cwd: process.cwd(),
				timeout: 600,
				canGenerate: true,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onOptionInsight: async (_questionId, option) => {
					seenOption = option;
					return { summary: "Looks good" };
				},
			},
		);

		try {
			const html = await (await fetch(handle.url)).text();
			const inlineDataMatch = html.match(/window\.__INTERVIEW_DATA__ = (\{[\s\S]*?\});/);
			expect(inlineDataMatch?.[1]).toBeTruthy();
			const inlineData = JSON.parse(inlineDataMatch![1]);
			const optionKey = inlineData.optionKeysByQuestion.policy[0];

			const response = await fetch(new URL("/option-insight", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "rich-option-token",
					questionId: "policy",
					optionKey,
					prompt: "Why this option?",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.optionText).toBe("Show nothing");
			expect(seenOption).toMatchObject({ label: "Show nothing" });
		} finally {
			handle.close();
		}
	});

	it("accepts option insight requests for blank string options", async () => {
		let seenOption: unknown;
		const handle = await startInterviewServer(
			{
				questions: {
					title: "Blank Option",
					questions: [
						{
							id: "policy",
							type: "single",
							question: "Pick one",
							options: ["", "Fallback to history"],
						},
					],
				},
				sessionToken: "blank-option-token",
				sessionId: "blank-option-session",
				cwd: process.cwd(),
				timeout: 600,
				canGenerate: true,
			},
			{
				onSubmit: () => {},
				onCancel: () => {},
				onOptionInsight: async (_questionId, option) => {
					seenOption = option;
					return { summary: "Looks good" };
				},
			},
		);

		try {
			const html = await (await fetch(handle.url)).text();
			const inlineDataMatch = html.match(/window\.__INTERVIEW_DATA__ = (\{[\s\S]*?\});/);
			expect(inlineDataMatch?.[1]).toBeTruthy();
			const inlineData = JSON.parse(inlineDataMatch![1]);
			const optionKey = inlineData.optionKeysByQuestion.policy[0];

			const response = await fetch(new URL("/option-insight", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "blank-option-token",
					questionId: "policy",
					optionKey,
					prompt: "Why this option?",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.optionText).toBe("");
			expect(seenOption).toBe("");
		} finally {
			handle.close();
		}
	});
});
