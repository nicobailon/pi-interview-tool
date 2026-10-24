import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import interviewExtension from "./index.ts";
import { validateQuestions } from "./schema.ts";
import { startInterviewServer } from "./server.ts";

vi.mock("./server.ts", () => ({
	startInterviewServer: vi.fn(),
	getActiveSessions: vi.fn(() => []),
}));
vi.mock("./settings.ts", () => ({ loadSettings: vi.fn(() => ({})) }));

type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ResultInput = Omit<Parameters<ResultRenderer>[0], "details"> & { details?: unknown };

// Only pre-launch validation is exercised; no form or provider context is needed.
const invalidInputContext = { hasUI: true, hasPendingMessages: () => false, cwd: process.cwd() } as unknown as ExtensionContext;

function registeredTool() {
	let tool: ToolDefinition | undefined;
	interviewExtension({ on: () => {}, registerTool: (value: ToolDefinition) => { tool = value; } } as unknown as ExtensionAPI);
	if (!tool?.renderResult || !tool.renderCall) throw new Error("Missing interview renderers");
	const definition = tool;
	const renderResult = tool.renderResult;
	const renderCall = tool.renderCall;
	const context: Parameters<ResultRenderer>[3] = {
		args: {}, toolCallId: "contract-test", invalidate: () => {}, lastComponent: undefined,
		state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true,
		isPartial: false, expanded: false, showImages: false, isError: false,
	};
	return {
		...definition,
		renderResult(result: ResultInput, options: Pick<ToolRenderResultOptions, "expanded">, theme: unknown) {
			// Missing/malformed details deliberately exercise the runtime error boundary.
			return renderResult(result as Parameters<ResultRenderer>[0], { ...options, isPartial: false },
				theme as Parameters<ResultRenderer>[2], { ...context, expanded: options.expanded });
		},
		renderCall(args: Parameters<CallRenderer>[0], theme: unknown) {
			return renderCall(args, theme as Parameters<CallRenderer>[1], { ...context, args });
		},
	};
}

function single(recommended: unknown) {
	return { questions: [{ id: "q", type: "single", question: "Pick one?",
		options: ["A", "B"], recommended }] };
}

const malformed = { option: "A", context: "Reason", conviction: "slight" };

describe("model-facing interview contract", () => {
	it("scopes recommendations to choice questions and explains sibling fields", () => {
		const { description } = registeredTool();
		expect(description).not.toContain("Always set recommended");
		expect(description).toContain("context and conviction are question-level fields");
		expect(description).toContain("Do not set recommended or conviction on text, image, or info");
	});

	it("ships a complete executable example with single and multi recommendations", () => {
		const { description } = registeredTool();
		const example = description.match(/Questions JSON example: (.+)\. Options can/);
		expect(example, "complete model-visible example").not.toBeNull();
		const parsed = validateQuestions(JSON.parse(example![1]));
		expect(parsed.questions.find((q) => q.type === "single")?.recommended).toBe("A");
		expect(parsed.questions.find((q) => q.type === "multi")?.recommended).toEqual(["X"]);
	});

	it("describes serialized JSON at the outer parameter boundary", () => {
		expect(registeredTool().parameters).toMatchObject({ properties: { questions: {
			description: expect.stringContaining("JSON object serialized as a string"),
		} } });
	});
});

describe("recommendation diagnostics without semantic repair", () => {
	it.each(["text", "image", "info"])("does not suggest adding recommended when conviction is invalid for %s", (type) => {
		expect(() => validateQuestions({ questions: [{ id: "q", type, question: "Notes?", conviction: "slight" }] }))
			.toThrow(/conviction not allowed.*only on single or multi/s);
	});

	it("rejects the observed nested object and identifies the sibling-field correction", () => {
		expect(() => validateQuestions(single(malformed))).toThrow(/recommended must be string for single-select.*context and conviction/s);
	});

	it("accepts the corrected exact label and preserves slight conviction", () => {
		const input = single("A");
		Object.assign(input.questions[0], { context: "Reason", conviction: "slight" });
		const question = validateQuestions(input).questions[0];
		expect(question.recommended).toBe("A");
		expect(question.context).toBe("Reason");
		expect(question.conviction).toBe("slight");
	});

	it("explains that text recommendations belong only on choice questions", () => {
		expect(() => validateQuestions({ questions: [{ id: "q", type: "text", question: "Notes?", recommended: "A" }] }))
			.toThrow(/recommended not allowed.*only on single or multi/s);
	});

	it("rejects a multi-select object with a type diagnostic rather than object coercion", () => {
		expect(() => validateQuestions({ questions: [{ id: "q", type: "multi", question: "Pick?", options: ["A", "B"], recommended: [malformed] }] }))
			.toThrow(/recommended must contain only strings.*context and conviction/s);
	});

	it("preserves the existing scalar and singleton-array compatibility", () => {
		expect(validateQuestions(single(["A"])).questions[0].recommended).toBe("A");
		expect(validateQuestions({ questions: [{ id: "q", type: "multi", question: "Pick?", options: ["A"], recommended: "A" }] }).questions[0].recommended).toEqual(["A"]);
	});

	it("still rejects exact-label mismatches and mixed recommendation sources", () => {
		expect(() => validateQuestions(single(" A "))).toThrow("not in options");
		const input = single("A");
		Object.assign(input.questions[0], { options: [{ label: "A", recommended: true }, "B"] });
		expect(() => validateQuestions(input)).toThrow("not both");
	});
});

describe("failed-call visibility and launch boundary", () => {
	it.each(["completed", "cancelled", "timeout", "aborted", "queued", "started"])("preserves upstream status rendering: %s", (status) => {
		const theme = { fg: (_color: string, text: string) => text };
		const rendered = registeredTool().renderResult({ content: [], details: { status, responses: [] } }, { expanded: false }, theme).render(120).join("\n");
		expect(rendered).toContain(status.toUpperCase());
		if (status === "started") expect(rendered).toContain("answer arrives later");
	});

	const controls = [
		...Array.from({ length: 32 }, (_, code) => code).filter((code) => code !== 10),
		127, ...Array.from({ length: 32 }, (_, code) => code + 128),
	];
	it.each(controls)("neutralizes tool-call header control code point %i", (code) => {
		const questions = `missing-${String.fromCharCode(code)}-file.json`;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const rendered = registeredTool().renderCall({ questions }, theme).render(120).join("\n");
		expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		expect(rendered).toContain(`missing-\\u${code.toString(16).padStart(4, "0")}-file.json`);
	});

	it.each(controls)("neutralizes diagnostic control code point %i", (code) => {
		const input = `before${String.fromCharCode(code)}after\nNext line`;
		const rendered = registeredTool().renderResult({ content: [{ type: "text", text: input }], details: {} }, { expanded: false }, {}).render(100).join("\n");
		expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		expect(rendered).toContain(`before\\u${code.toString(16).padStart(4, "0")}after`);
		expect(rendered).toContain("\nNext line");
	});

	it.each([
		undefined, null, {}, { status: "unknown", responses: [] },
		{ status: "completed", responses: null },
		{ status: "queued", responses: [], queuedMessage: {} },
	])("renders error content for absent or malformed runtime details: %j", (details) => {
		const diagnostic = "Invalid interview input";
		const rendered = registeredTool().renderResult({ content: [{ type: "text", text: diagnostic }], details }, { expanded: false }, {});
		expect(rendered.render(80).join("\n")).toContain(diagnostic);
	});

	it("visibly escapes untrusted terminal controls while retaining line breaks", () => {
		let diagnostic = "";
		try {
			validateQuestions({ questions: [{ id: "q\u001b]52;c;payload\u0007\u009b31m\u007f", type: "single", question: "Pick?", options: ["A"], recommended: malformed }] });
		} catch (error) {
			diagnostic = (error as Error).message;
		}
		const rendered = registeredTool().renderResult({ content: [{ type: "text", text: diagnostic + "\nNext line" }] }, { expanded: false }, {}).render(300).join("\n");
		expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		expect(rendered).toContain("\\u001b]52;c;payload\\u0007\\u009b31m\\u007f");
		expect(rendered).toContain("\nNext line");
	});

	it("retains normal completed and queued status rendering", () => {
		const theme = { fg: (_color: string, text: string) => text };
		const tool = registeredTool();
		expect(tool.renderResult({ content: [], details: { status: "completed", responses: [] } }, { expanded: false }, theme).render(80).join("\n")).toContain("COMPLETED (0 responses)");
		const queued = tool.renderResult({ content: [], details: { status: "queued", responses: [], queuedMessage: "Waiting." } }, { expanded: false }, theme).render(80).join("\n");
		expect(queued).toContain("QUEUED");
		expect(queued).toContain("Waiting.");
	});

	it("renders an execute failure wrapped with the supported runtime's empty details", async () => {
		const tool = registeredTool();
		let diagnostic = "";
		try {
			await tool.execute("runtime-error-shape", { questions: JSON.stringify(single(malformed)) }, undefined, undefined,
				invalidInputContext);
		} catch (error) {
			diagnostic = (error as Error).message;
		}
		expect(diagnostic).toContain("context and conviction");
		const rendered = tool.renderResult({ content: [{ type: "text", text: diagnostic }], details: {} }, { expanded: false }, {}).render(300).join("\n");
		expect(rendered).toContain("recommended must be string for single-select");
	});

	it("renders the actual textual diagnostic when structured details are absent", () => {
		const diagnostic = 'Question "q": recommended must be string for single-select';
		const rendered = registeredTool().renderResult({ content: [{ type: "text", text: diagnostic }] }, { expanded: false }, {});
		expect(rendered.render(120).join("\n")).toContain(diagnostic);
	});

	it("keeps the empty-result fallback", () => {
		expect(registeredTool().renderResult({ content: [] }, { expanded: false }, {}).render(80).join("\n")).toContain("Interview");
	});

	it("rejects malformed input before starting the form server", async () => {
		vi.mocked(startInterviewServer).mockClear();
		await expect(registeredTool().execute("contract-test", { questions: JSON.stringify(single(malformed)) }, undefined, undefined,
			invalidInputContext))
			.rejects.toThrow(/context and conviction/);
		expect(startInterviewServer).not.toHaveBeenCalled();
	});
});
