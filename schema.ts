import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

const QuestionType = StringEnum(["single", "multi", "text", "image"] as const);

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier" }),
	type: QuestionType,
	question: Type.String({ description: "Question text" }),
	options: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
	recommended: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	context: Type.Optional(Type.String({ description: "Help text" })),
});

export const QuestionsFileSchema = Type.Object({
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	questions: Type.Array(QuestionSchema, { minItems: 1 }),
});

export type Question = Static<typeof QuestionSchema>;
export type QuestionsFile = Static<typeof QuestionsFileSchema>;

function validateBasicStructure(data: unknown): QuestionsFile {
	if (!data || typeof data !== "object") {
		throw new Error("Invalid questions file: must be an object");
	}
	
	const obj = data as Record<string, unknown>;
	
	if (obj.title !== undefined && typeof obj.title !== "string") {
		throw new Error("Invalid questions file: title must be a string");
	}
	
	if (obj.description !== undefined && typeof obj.description !== "string") {
		throw new Error("Invalid questions file: description must be a string");
	}
	
	if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
		throw new Error("Invalid questions file: questions must be a non-empty array");
	}
	
	const validTypes = ["single", "multi", "text", "image"];
	for (let i = 0; i < obj.questions.length; i++) {
		const q = obj.questions[i] as Record<string, unknown>;
		if (!q || typeof q !== "object") {
			throw new Error(`Invalid question at index ${i}: must be an object`);
		}
		if (typeof q.id !== "string") {
			throw new Error(`Invalid question at index ${i}: id must be a string`);
		}
		if (typeof q.type !== "string" || !validTypes.includes(q.type)) {
			throw new Error(`Question "${q.id}": type must be one of: ${validTypes.join(", ")}`);
		}
		if (typeof q.question !== "string") {
			throw new Error(`Question "${q.id}": question text must be a string`);
		}
		if (q.options !== undefined) {
			if (!Array.isArray(q.options) || q.options.length === 0 || q.options.some((o: unknown) => typeof o !== "string")) {
				throw new Error(`Question "${q.id}": options must be a non-empty array of strings`);
			}
		}
		if (q.context !== undefined && typeof q.context !== "string") {
			throw new Error(`Question "${q.id}": context must be a string`);
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
		} else if (q.type === "text" || q.type === "image") {
			if (q.options) {
				throw new Error(`Question "${q.id}": options not allowed for type "${q.type}"`);
			}
		}

		if (q.recommended !== undefined) {
			if (q.type === "text" || q.type === "image") {
				throw new Error(`Question "${q.id}": recommended not allowed for type "${q.type}"`);
			}

			if (q.type === "single") {
				if (typeof q.recommended !== "string") {
					throw new Error(`Question "${q.id}": recommended must be string for single-select`);
				}
				if (!q.options?.includes(q.recommended)) {
					throw new Error(
						`Question "${q.id}": recommended "${q.recommended}" not in options`
					);
				}
			}

			if (q.type === "multi") {
				const recs = Array.isArray(q.recommended) ? q.recommended : [q.recommended];
				for (const rec of recs) {
					if (!q.options?.includes(rec)) {
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
