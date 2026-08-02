export interface BaseContentBlock {
	source: string;
	lang?: string;
	file?: string;
	title?: string;
}

export interface MarkdownContentBlock extends BaseContentBlock {
	lang: "md" | "markdown";
	showSource?: boolean;
	lines?: never;
	highlights?: never;
}

export interface CodeContentBlock extends BaseContentBlock {
	lines?: string;
	highlights?: number[];
	showSource?: never;
}

export type ContentBlock = MarkdownContentBlock | CodeContentBlock;

export interface RichOption {
	label: string;
	content?: ContentBlock;
	recommended?: boolean;
	conviction?: "strong" | "slight";
}

export type OptionValue = string | RichOption;

export interface MediaBlock {
	type: "image" | "chart" | "mermaid" | "table" | "html";
	src?: string;
	alt?: string;
	chart?: {
		type: string;
		data: Record<string, unknown>;
		options?: Record<string, unknown>;
	};
	mermaid?: string;
	table?: {
		headers: string[];
		rows: string[][];
		highlights?: number[];
	};
	html?: string;
	caption?: string;
	position?: "above" | "below" | "side";
	maxHeight?: string;
}

export interface Question {
	id: string;
	type: "single" | "multi" | "text" | "image" | "info";
	question: string;
	options?: OptionValue[];
	recommended?: string | string[];
	conviction?: "strong" | "slight";
	weight?: "critical" | "minor";
	context?: string;
	content?: ContentBlock;
	media?: MediaBlock | MediaBlock[];
}

export interface QuestionsFile {
	title?: string;
	description?: string;
	questions: Question[];
}

export function getOptionLabel(option: OptionValue): string {
	return typeof option === "string" ? option : option.label;
}

export function isRichOption(option: OptionValue): option is RichOption {
	return typeof option === "object" && option !== null && "label" in option;
}

function normalizeOptionLevelRecommendations(question: Question): void {
	if (!question.options) return;

	const recommendedOptions: RichOption[] = [];
	const convictions = new Set<"strong" | "slight">();
	const richOptions: RichOption[] = [];

	for (const option of question.options) {
		if (!isRichOption(option)) continue;
		richOptions.push(option);
		if (option.conviction !== undefined && option.recommended !== true) {
			throw new Error(
				`Question "${question.id}" option "${option.label}": conviction requires recommended`
			);
		}
		if (option.recommended !== true) continue;
		recommendedOptions.push(option);
		if (option.conviction) convictions.add(option.conviction);
	}

	if (recommendedOptions.length === 0) return;

	if (question.recommended !== undefined || question.conviction !== undefined) {
		throw new Error(
			`Question "${question.id}": use either question-level recommended/conviction or option-level recommended flags, not both`
		);
	}

	if (question.type === "single" && recommendedOptions.length !== 1) {
		throw new Error(`Question "${question.id}": exactly one option must be recommended for single-select`);
	}

	if (convictions.size > 1) {
		throw new Error(
			`Question "${question.id}": recommended options must use the same conviction`
		);
	}

	for (const option of richOptions) {
		delete option.recommended;
		delete option.conviction;
	}

	const recommendedLabels = recommendedOptions.map((option) => option.label);
	question.recommended = question.type === "single" ? recommendedLabels[0] : recommendedLabels;
	const conviction = convictions.values().next().value;
	if (conviction !== undefined) {
		question.conviction = conviction;
	}
}

function validateMediaBlock(block: unknown, context: string): MediaBlock {
	if (!block || typeof block !== "object") {
		throw new Error(`${context}: media must be an object`);
	}
	const b = block as Record<string, unknown>;
	const validMediaTypes = ["image", "chart", "mermaid", "table", "html"];
	if (typeof b.type !== "string" || !validMediaTypes.includes(b.type)) {
		throw new Error(`${context}: media.type must be one of: ${validMediaTypes.join(", ")}`);
	}

	if (b.type === "image" && typeof b.src !== "string") {
		throw new Error(`${context}: media.src required for image type`);
	}
	if (b.type === "chart") {
		if (!b.chart || typeof b.chart !== "object") {
			throw new Error(`${context}: media.chart required for chart type`);
		}
		const chart = b.chart as Record<string, unknown>;
		if (typeof chart.type !== "string") {
			throw new Error(`${context}: media.chart.type must be a string`);
		}
		if (!chart.data || typeof chart.data !== "object") {
			throw new Error(`${context}: media.chart.data must be an object`);
		}
	}
	if (b.type === "mermaid" && typeof b.mermaid !== "string") {
		throw new Error(`${context}: media.mermaid required for mermaid type`);
	}
	if (b.type === "table") {
		if (!b.table || typeof b.table !== "object") {
			throw new Error(`${context}: media.table required for table type`);
		}
		const table = b.table as Record<string, unknown>;
		if (!Array.isArray(table.headers)) {
			throw new Error(`${context}: media.table.headers must be an array`);
		}
		if (!Array.isArray(table.rows)) {
			throw new Error(`${context}: media.table.rows must be an array`);
		}
	}
	if (b.type === "html" && typeof b.html !== "string") {
		throw new Error(`${context}: media.html required for html type`);
	}

	if (b.position !== undefined) {
		const validPositions = ["above", "below", "side"];
		if (!validPositions.includes(b.position as string)) {
			throw new Error(`${context}: media.position must be one of: ${validPositions.join(", ")}`);
		}
	}

	return b as unknown as MediaBlock;
}

const SCHEMA_EXAMPLE = `Expected format:
{
  "title": "Optional Title",
  "questions": [
    { "id": "q1", "type": "single", "question": "Pick one?", "options": ["A", "B"] },
    { "id": "q2", "type": "multi", "question": "Pick many?", "options": ["X", "Y", "Z"] },
    { "id": "q3", "type": "text", "question": "Describe?" },
    { "id": "q4", "type": "image", "question": "Upload?" }
  ]
}
Valid types: single, multi, text, image, info
Options: array of strings or objects with { label, content? }`;

function isMarkdownLang(lang: unknown): lang is "md" | "markdown" {
	if (typeof lang !== "string") return false;
	const normalized = lang.trim().toLowerCase();
	return normalized === "md" || normalized === "markdown";
}

function validateContentBlock(block: unknown, context: string): ContentBlock {
	if (!block || typeof block !== "object") {
		throw new Error(`${context}: content must be an object`);
	}
	const b = block as Record<string, unknown>;
	if (typeof b.source !== "string") {
		throw new Error(`${context}: content.source must be a string`);
	}
	if (b.lang !== undefined && typeof b.lang !== "string") {
		throw new Error(`${context}: content.lang must be a string`);
	}
	if (b.file !== undefined && typeof b.file !== "string") {
		throw new Error(`${context}: content.file must be a string`);
	}
	if (b.lines !== undefined && typeof b.lines !== "string") {
		throw new Error(`${context}: content.lines must be a string`);
	}
	if (b.title !== undefined && typeof b.title !== "string") {
		throw new Error(`${context}: content.title must be a string`);
	}
	if (b.showSource !== undefined && typeof b.showSource !== "boolean") {
		throw new Error(`${context}: content.showSource must be a boolean`);
	}
	if (b.highlights !== undefined) {
		if (!Array.isArray(b.highlights) || b.highlights.some((h) => typeof h !== "number")) {
			throw new Error(`${context}: content.highlights must be an array of numbers`);
		}
	}

	if (isMarkdownLang(b.lang)) {
		if (b.lines !== undefined) {
			throw new Error(`${context}: content.lines is not allowed for markdown content`);
		}
		if (b.highlights !== undefined) {
			throw new Error(`${context}: content.highlights is not allowed for markdown content`);
		}
		return {
			source: b.source,
			lang: b.lang.trim().toLowerCase() as "md" | "markdown",
			...(typeof b.file === "string" ? { file: b.file } : {}),
			...(typeof b.title === "string" ? { title: b.title } : {}),
			...(typeof b.showSource === "boolean" ? { showSource: b.showSource } : {}),
		};
	}

	if (b.showSource !== undefined) {
		throw new Error(`${context}: content.showSource is only valid when content.lang is "md" or "markdown"`);
	}

	return {
		source: b.source,
		...(typeof b.lang === "string" ? { lang: b.lang } : {}),
		...(typeof b.file === "string" ? { file: b.file } : {}),
		...(typeof b.title === "string" ? { title: b.title } : {}),
		...(typeof b.lines === "string" ? { lines: b.lines } : {}),
		...(Array.isArray(b.highlights) ? { highlights: b.highlights as number[] } : {}),
	};
}

function validateOption(option: unknown, questionId: string, index: number): OptionValue {
	if (typeof option === "string") {
		return option;
	}
	if (option && typeof option === "object") {
		const o = option as Record<string, unknown>;
		if (typeof o.label !== "string") {
			throw new Error(
				`Question "${questionId}": option at index ${index} must have a "label" string`
			);
		}
		if (o.code !== undefined) {
			throw new Error(
				`Question "${questionId}" option "${o.label}": legacy "code" is no longer supported; use "content"`
			);
		}
		if (o.content !== undefined) {
			const result: RichOption = {
				label: o.label,
				content: validateContentBlock(o.content, `Question "${questionId}" option "${o.label}"`),
			};
			if (o.recommended === true) result.recommended = true;
			if (o.conviction === "strong" || o.conviction === "slight") result.conviction = o.conviction;
			return result;
		}
		const result: RichOption = { label: o.label };
		if (o.recommended === true) result.recommended = true;
		if (o.conviction === "strong" || o.conviction === "slight") result.conviction = o.conviction;
		return result;
	}
	throw new Error(
		`Question "${questionId}": option at index ${index} must be a string or object with label`
	);
}

function validateBasicStructure(data: unknown): QuestionsFile {
	if (Array.isArray(data)) {
		throw new Error(
			`Invalid questions file: root must be an object, not an array.\n\n${SCHEMA_EXAMPLE}`
		);
	}

	if (!data || typeof data !== "object") {
		throw new Error(`Invalid questions file: must be an object.\n\n${SCHEMA_EXAMPLE}`);
	}
	
	const obj = data as Record<string, unknown>;

	if (("label" in obj || "description" in obj) && !("questions" in obj)) {
		throw new Error(
			`Invalid questions file: missing "questions" array. Did you mean to wrap your questions?\n\n${SCHEMA_EXAMPLE}`
		);
	}
	
	if (obj.title !== undefined && typeof obj.title !== "string") {
		throw new Error("Invalid questions file: title must be a string");
	}
	
	if (obj.description !== undefined && typeof obj.description !== "string") {
		throw new Error("Invalid questions file: description must be a string");
	}
	
	if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
		throw new Error(
			`Invalid questions file: "questions" must be a non-empty array.\n\n${SCHEMA_EXAMPLE}`
		);
	}
	
	const validTypes = ["single", "multi", "text", "image", "info"];
	for (let i = 0; i < obj.questions.length; i++) {
		const q = obj.questions[i] as Record<string, unknown>;
		if (!q || typeof q !== "object") {
			throw new Error(`Invalid question at index ${i}: must be an object`);
		}
		if (typeof q.id !== "string") {
			throw new Error(`Invalid question at index ${i}: id must be a string`);
		}

		if (typeof q.type !== "string" || !validTypes.includes(q.type)) {
			const hint = q.type === "select" ? ' (use "single" instead of "select")' : "";
			throw new Error(
				`Question "${q.id}": type must be one of: ${validTypes.join(", ")}${hint}`
			);
		}

		if (typeof q.question !== "string") {
			const hint = "label" in q || "description" in q 
				? ' (use "question" field, not "label" or "description")'
				: "";
			throw new Error(`Question "${q.id}": "question" field must be a string${hint}`);
		}

		if (q.options !== undefined) {
			if (!Array.isArray(q.options) || q.options.length === 0) {
				throw new Error(`Question "${q.id}": options must be a non-empty array`);
			}
			for (let j = 0; j < q.options.length; j++) {
				q.options[j] = validateOption(q.options[j], q.id as string, j);
			}
		}

		if (q.context !== undefined && typeof q.context !== "string") {
			throw new Error(`Question "${q.id}": context must be a string`);
		}

		if (q.codeBlock !== undefined) {
			throw new Error(`Question "${q.id}": legacy "codeBlock" is no longer supported; use "content"`);
		}
		if (q.content !== undefined) {
			q.content = validateContentBlock(q.content, `Question "${q.id}"`);
		}

		if (q.conviction !== undefined) {
			const validConvictions = ["strong", "slight"];
			if (typeof q.conviction !== "string" || !validConvictions.includes(q.conviction)) {
				throw new Error(`Question "${q.id}": conviction must be "strong" or "slight"`);
			}
		}

		if (q.weight !== undefined) {
			const validWeights = ["critical", "minor"];
			if (typeof q.weight !== "string" || !validWeights.includes(q.weight)) {
				throw new Error(`Question "${q.id}": weight must be "critical" or "minor"`);
			}
		}

		if (q.media !== undefined) {
			const mediaItems = Array.isArray(q.media) ? q.media : [q.media];
			for (let m = 0; m < mediaItems.length; m++) {
				validateMediaBlock(mediaItems[m], `Question "${q.id}" media[${m}]`);
			}
		}
	}
	
	return obj as unknown as QuestionsFile;
}

export function validateQuestions(data: unknown): QuestionsFile {
	const parsed = validateBasicStructure(data);

	const ids = new Set<string>();
	for (const q of parsed.questions) {
		if (ids.has(q.id)) {
			throw new Error(`Duplicate question id: "${q.id}"`);
		}
		ids.add(q.id);
	}

	for (const q of parsed.questions) {
		if (q.type === "single" || q.type === "multi") {
			if (!q.options || q.options.length === 0) {
				throw new Error(`Question "${q.id}": options required for type "${q.type}"`);
			}
			normalizeOptionLevelRecommendations(q);
		} else if (q.type === "text" || q.type === "image" || q.type === "info") {
			if (q.options) {
				throw new Error(`Question "${q.id}": options not allowed for type "${q.type}"`);
			}
		}

		if (q.conviction !== undefined && q.recommended === undefined) {
			throw new Error(`Question "${q.id}": conviction requires recommended`);
		}

		if (q.recommended !== undefined) {
			if (q.type === "text" || q.type === "image" || q.type === "info") {
				throw new Error(`Question "${q.id}": recommended not allowed for type "${q.type}"`);
			}

			const optionLabels = q.options?.map(getOptionLabel) ?? [];

			if (q.type === "single") {
				if (Array.isArray(q.recommended) && q.recommended.length === 1) {
					q.recommended = q.recommended[0];
				}
				if (typeof q.recommended !== "string") {
					throw new Error(`Question "${q.id}": recommended must be string for single-select`);
				}
				if (!optionLabels.includes(q.recommended)) {
					throw new Error(
						`Question "${q.id}": recommended "${q.recommended}" not in options`
					);
				}
			}

			if (q.type === "multi") {
				const recs = Array.isArray(q.recommended) ? q.recommended : [q.recommended];
				for (const rec of recs) {
					if (!optionLabels.includes(rec)) {
						throw new Error(`Question "${q.id}": recommended "${rec}" not in options`);
					}
				}
				if (!Array.isArray(q.recommended)) {
					q.recommended = recs;
				}
			}
		}
	}

	return parsed;
}

// Repair common LLM JSON mistakes (code fences, trailing commas, comments, smart quotes).
// Only called as a fallback when JSON.parse() already failed.
export function sanitizeLLMJSON(input: string): string {
	let json = input.trim();

	const fenceMatch = json.match(/^`{3,}(?:json|jsonc)?\s*\n([\s\S]*?)\n\s*`{3,}\s*$/i);
	if (fenceMatch) {
		json = fenceMatch[1];
	}

	json = json.replace(/^\s*\/\/.*$/gm, "");
	json = json.replace(/,(\s*[}\]])/g, "$1");
	json = json.replace(/\u201C|\u201D/g, '"');

	return json.trim();
}
