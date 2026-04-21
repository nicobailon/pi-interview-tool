import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInterviewServer } from "./server.js";
import interviewExtension, {
	createGenerateContext,
	extractGenerateResponseText,
	extractJSONArray,
	loadSavedInterview,
	parseGeneratedOptionValues,
	parseOptionInsight,
	parseGeneratedOptions,
	parseReviewedQuestion,
	parseReviewedQuestionUpdate,
	selectGenerateModels,
} from "./index.js";

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
				errorMessage: undefined,
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

	it("includes the option-body alignment and clarification input styles", () => {
		const styles = readFileSync("form/styles.css", "utf-8");
		expect(styles).toMatch(/\.option-item-label \{[^}]*align-items: center;/s);
		expect(styles).toMatch(/input\[type="radio"\],\s*input\[type="checkbox"\] \{[^}]*margin-top: 2px;/s);
		expect(styles).toContain(".option-note-input");
	});

	it("preserves structured choice answers across option rewrites and review", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain("function renameChoiceAnswerValue(question, value, previousOption, nextOption)");
		expect(clientSource).toContain("function preserveChoiceAnswerValue(question, value, validLabels)");
		expect(clientSource).toContain("nextValue = renameChoiceAnswerValue(question, preservedValue, previousText, text);");
		expect(clientSource).toContain("const nextValue = preserveChoiceAnswerValue(question, currentValue, revisedLabels);");
	});

	it("keeps deselected clarification drafts across option rerenders", () => {
		const clientSource = readFileSync("form/script.js", "utf-8");
		expect(clientSource).toContain("populateForm({ [question.id]: value }, { preserveChoiceNotes: true });");
		expect(clientSource).toContain("if (!preserveChoiceNotes) {\n          clearChoiceNotes(question.id);\n        }");
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

describe("rich option question flows", () => {
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
							options: ["React", "Vue"],
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

	it("preserves rich option content when rewriting the label", async () => {
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
							],
						},
					],
				},
				sessionToken: "rich-option-action-token",
				sessionId: "rich-option-action-session",
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
			const inlineData = JSON.parse(inlineDataMatch![1]);
			const optionKey = inlineData.optionKeysByQuestion.policy[0];

			const response = await fetch(new URL("/option-action", handle.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: "rich-option-action-token",
					questionId: "policy",
					optionKey,
					action: "replace-text",
					text: "Hide invalid suggestions",
				}),
			});
			const result = await response.json();

			expect(response.status).toBe(200);
			expect(result.question.options[0]).toEqual({
				label: "Hide invalid suggestions",
				content: { source: "No suggestion is better than a misleading one.", lang: "md" },
			});
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
