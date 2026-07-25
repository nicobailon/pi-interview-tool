import { describe, it, expect } from "vitest";
import { validateQuestions, getOptionLabel, isRichOption, sanitizeLLMJSON } from "./schema.ts";

function valid(overrides: Record<string, unknown> = {}) {
	return {
		questions: [
			{ id: "q1", type: "single", question: "Pick one?", options: ["A", "B"], ...overrides },
		],
	};
}

function validMulti(overrides: Record<string, unknown> = {}) {
	return {
		questions: [
			{ id: "q1", type: "multi", question: "Pick many?", options: ["X", "Y", "Z"], ...overrides },
		],
	};
}

describe("validateQuestions", () => {
	describe("happy path", () => {
		it("accepts minimal single-select", () => {
			const result = validateQuestions(valid());
			expect(result.questions).toHaveLength(1);
			expect(result.questions[0].type).toBe("single");
		});

		it("accepts multi-select", () => {
			const result = validateQuestions(validMulti());
			expect(result.questions[0].type).toBe("multi");
		});

		it("accepts text question", () => {
			const result = validateQuestions({
				questions: [{ id: "q1", type: "text", question: "Describe?" }],
			});
			expect(result.questions[0].type).toBe("text");
		});

		it("accepts image question", () => {
			const result = validateQuestions({
				questions: [{ id: "q1", type: "image", question: "Upload?" }],
			});
			expect(result.questions[0].type).toBe("image");
		});

		it("accepts info question", () => {
			const result = validateQuestions({
				questions: [{ id: "q1", type: "info", question: "Context here" }],
			});
			expect(result.questions[0].type).toBe("info");
		});

		it("accepts title and description", () => {
			const result = validateQuestions({
				title: "My Form",
				description: "Please answer",
				questions: [{ id: "q1", type: "text", question: "Name?" }],
			});
			expect(result.title).toBe("My Form");
			expect(result.description).toBe("Please answer");
		});

		it("accepts mixed question types", () => {
			const result = validateQuestions({
				questions: [
					{ id: "q1", type: "single", question: "Pick?", options: ["A", "B"] },
					{ id: "q2", type: "multi", question: "Select?", options: ["X", "Y"] },
					{ id: "q3", type: "text", question: "Describe?" },
					{ id: "q4", type: "image", question: "Upload?" },
					{ id: "q5", type: "info", question: "Note" },
				],
			});
			expect(result.questions).toHaveLength(5);
		});
	});

	describe("root structure", () => {
		it("rejects array at root", () => {
			expect(() => validateQuestions([{ id: "q1" }])).toThrow("not an array");
		});

		it("rejects null", () => {
			expect(() => validateQuestions(null)).toThrow("must be an object");
		});

		it("rejects string", () => {
			expect(() => validateQuestions("hello")).toThrow("must be an object");
		});

		it("rejects missing questions array", () => {
			expect(() => validateQuestions({ title: "Test" })).toThrow("non-empty array");
		});

		it("rejects empty questions array", () => {
			expect(() => validateQuestions({ questions: [] })).toThrow("non-empty array");
		});

		it("hints when label/description present but questions missing", () => {
			expect(() => validateQuestions({ label: "Test", description: "Hi" })).toThrow(
				"Did you mean to wrap"
			);
		});

		it("rejects non-string title", () => {
			expect(() => validateQuestions({
				title: 123,
				questions: [{ id: "q1", type: "text", question: "?" }],
			})).toThrow("title must be a string");
		});

		it("rejects non-string description", () => {
			expect(() => validateQuestions({
				description: true,
				questions: [{ id: "q1", type: "text", question: "?" }],
			})).toThrow("description must be a string");
		});
	});

	describe("question field validation", () => {
		it("rejects missing id", () => {
			expect(() =>
				validateQuestions({ questions: [{ type: "text", question: "?" }] })
			).toThrow("id must be a string");
		});

		it("rejects invalid type", () => {
			expect(() =>
				validateQuestions({ questions: [{ id: "q1", type: "dropdown", question: "?" }] })
			).toThrow("type must be one of");
		});

		it("hints select → single", () => {
			expect(() =>
				validateQuestions({ questions: [{ id: "q1", type: "select", question: "?" }] })
			).toThrow('use "single"');
		});

		it("rejects missing question text", () => {
			expect(() =>
				validateQuestions({ questions: [{ id: "q1", type: "text" }] })
			).toThrow('"question" field must be a string');
		});

		it("hints label → question", () => {
			expect(() =>
				validateQuestions({ questions: [{ id: "q1", type: "text", label: "Name?" }] })
			).toThrow('use "question" field');
		});

		it("rejects non-string context", () => {
			expect(() => validateQuestions(valid({ context: 123 }))).toThrow(
				"context must be a string"
			);
		});

		it("rejects duplicate ids", () => {
			expect(() =>
				validateQuestions({
					questions: [
						{ id: "q1", type: "text", question: "A?" },
						{ id: "q1", type: "text", question: "B?" },
					],
				})
			).toThrow('Duplicate question id: "q1"');
		});
	});

	describe("options", () => {
		it("requires options for single-select", () => {
			expect(() =>
				validateQuestions({ questions: [{ id: "q1", type: "single", question: "?" }] })
			).toThrow("options required");
		});

		it("requires options for multi-select", () => {
			expect(() =>
				validateQuestions({ questions: [{ id: "q1", type: "multi", question: "?" }] })
			).toThrow("options required");
		});

		it("rejects options on text", () => {
			expect(() => validateQuestions({
				questions: [{ id: "q1", type: "text", question: "?", options: ["A"] }],
			})).toThrow("options not allowed");
		});

		it("rejects options on image", () => {
			expect(() => validateQuestions({
				questions: [{ id: "q1", type: "image", question: "?", options: ["A"] }],
			})).toThrow("options not allowed");
		});

		it("rejects options on info", () => {
			expect(() => validateQuestions({
				questions: [{ id: "q1", type: "info", question: "?", options: ["A"] }],
			})).toThrow("options not allowed");
		});

		it("rejects empty options array", () => {
			expect(() => validateQuestions(valid({ options: [] }))).toThrow(
				"non-empty array"
			);
		});

		it("accepts rich options with label and content", () => {
			const result = validateQuestions(valid({
				options: [
					{ label: "A", content: { source: "const a = 1;", lang: "ts" } },
					{ label: "B" },
				],
			}));
			expect(result.questions[0].options).toHaveLength(2);
		});

		it("rejects rich option without label", () => {
			expect(() => validateQuestions(valid({ options: [{ content: { source: "x" } }] }))).toThrow(
				'must have a "label" string'
			);
		});

		it("rejects legacy rich option code field", () => {
			expect(() => validateQuestions(valid({
				options: [{ label: "A", code: { code: "x" } }],
			}))).toThrow('legacy "code" is no longer supported; use "content"');
		});

		it("rejects non-string non-object option", () => {
			expect(() => validateQuestions(valid({ options: [42] }))).toThrow(
				"must be a string or object"
			);
		});
	});

	describe("recommended", () => {
		it("normalizes single-select option-level recommended flags", () => {
			const result = validateQuestions(valid({
				options: [{ label: "A", recommended: true }, { label: "B" }],
			}));
			expect(result.questions[0].recommended).toBe("A");
			expect(result.questions[0].options).toEqual([{ label: "A" }, { label: "B" }]);
		});

		it("normalizes multi-select option-level recommended flags", () => {
			const result = validateQuestions(validMulti({
				options: [{ label: "X", recommended: true }, { label: "Y" }, { label: "Z", recommended: true }],
			}));
			expect(result.questions[0].recommended).toEqual(["X", "Z"]);
			expect(result.questions[0].options).toEqual([{ label: "X" }, { label: "Y" }, { label: "Z" }]);
		});

		it("keeps normalized option-level recommendations revalidatable", () => {
			const first = validateQuestions(valid({
				options: [{ label: "A", recommended: true, conviction: "strong" }, { label: "B" }],
			}));
			expect(() => validateQuestions(structuredClone(first))).not.toThrow();
		});

		it("accepts recommended for single-select", () => {
			const result = validateQuestions(valid({ recommended: "A" }));
			expect(result.questions[0].recommended).toBe("A");
		});

		it("accepts recommended array for multi-select", () => {
			const result = validateQuestions(validMulti({ recommended: ["X", "Z"] }));
			expect(result.questions[0].recommended).toEqual(["X", "Z"]);
		});

		it("wraps single recommended string in array for multi", () => {
			const result = validateQuestions(validMulti({ recommended: "X" }));
			expect(result.questions[0].recommended).toEqual(["X"]);
		});

		it("unwraps single-element array for single-select", () => {
			const result = validateQuestions(valid({ recommended: ["A"] }));
			expect(result.questions[0].recommended).toBe("A");
		});

		it("rejects recommended not in options for single", () => {
			expect(() => validateQuestions(valid({ recommended: "C" }))).toThrow(
				'recommended "C" not in options'
			);
		});

		it("rejects recommended not in options for multi", () => {
			expect(() => validateQuestions(validMulti({ recommended: ["X", "W"] }))).toThrow(
				'recommended "W" not in options'
			);
		});

		it("rejects recommended on text", () => {
			expect(() => validateQuestions({
				questions: [{ id: "q1", type: "text", question: "?", recommended: "A" }],
			})).toThrow("recommended not allowed");
		});

		it("rejects recommended on image", () => {
			expect(() => validateQuestions({
				questions: [{ id: "q1", type: "image", question: "?", recommended: "A" }],
			})).toThrow("recommended not allowed");
		});

		it("rejects recommended on info", () => {
			expect(() => validateQuestions({
				questions: [{ id: "q1", type: "info", question: "?", recommended: "A" }],
			})).toThrow("recommended not allowed");
		});

		it("rejects non-string recommended for single", () => {
			expect(() => validateQuestions(valid({ recommended: ["A", "B"] }))).toThrow(
				"recommended must be string for single-select"
			);
		});

		it("rejects multiple option-level recommendations for single-select", () => {
			expect(() => validateQuestions(valid({
				options: [{ label: "A", recommended: true }, { label: "B", recommended: true }],
			}))).toThrow("exactly one option must be recommended for single-select");
		});

		it("rejects mixed question-level and option-level recommendations", () => {
			expect(() => validateQuestions(valid({
				recommended: "A",
				options: [{ label: "A", recommended: true }, { label: "B" }],
			}))).toThrow("use either question-level recommended/conviction or option-level recommended flags, not both");
		});
	});

	describe("conviction", () => {
		it("normalizes option-level conviction", () => {
			const result = validateQuestions(valid({
				options: [{ label: "A", recommended: true, conviction: "strong" }, { label: "B" }],
			}));
			expect(result.questions[0].recommended).toBe("A");
			expect(result.questions[0].conviction).toBe("strong");
		});

		it("accepts strong conviction with recommended", () => {
			const result = validateQuestions(valid({ recommended: "A", conviction: "strong" }));
			expect(result.questions[0].conviction).toBe("strong");
		});

		it("accepts slight conviction with recommended", () => {
			const result = validateQuestions(valid({ recommended: "A", conviction: "slight" }));
			expect(result.questions[0].conviction).toBe("slight");
		});

		it("rejects conviction without recommended", () => {
			expect(() => validateQuestions(valid({ conviction: "strong" }))).toThrow(
				"conviction requires recommended"
			);
		});

		it("rejects invalid conviction value", () => {
			expect(() => validateQuestions(valid({ recommended: "A", conviction: "high" }))).toThrow(
				'conviction must be "strong" or "slight"'
			);
		});

		it("rejects non-string conviction", () => {
			expect(() => validateQuestions(valid({ recommended: "A", conviction: true }))).toThrow(
				'conviction must be "strong" or "slight"'
			);
		});

		it("rejects option-level conviction without option-level recommended", () => {
			expect(() => validateQuestions(valid({
				options: [{ label: "A", conviction: "strong" }, { label: "B" }],
			}))).toThrow('option "A": conviction requires recommended');
		});

		it("rejects mixed option-level convictions", () => {
			expect(() => validateQuestions(validMulti({
				options: [
					{ label: "X", recommended: true, conviction: "strong" },
					{ label: "Y" },
					{ label: "Z", recommended: true, conviction: "slight" },
				],
			}))).toThrow("recommended options must use the same conviction");
		});
	});

	describe("weight", () => {
		it("accepts critical weight", () => {
			const result = validateQuestions(valid({ weight: "critical" }));
			expect(result.questions[0].weight).toBe("critical");
		});

		it("accepts minor weight", () => {
			const result = validateQuestions(valid({ weight: "minor" }));
			expect(result.questions[0].weight).toBe("minor");
		});

		it("rejects invalid weight value", () => {
			expect(() => validateQuestions(valid({ weight: "high" }))).toThrow(
				'weight must be "critical" or "minor"'
			);
		});

		it("rejects non-string weight", () => {
			expect(() => validateQuestions(valid({ weight: 1 }))).toThrow(
				'weight must be "critical" or "minor"'
			);
		});
	});

	describe("media", () => {
		it("accepts image media", () => {
			const result = validateQuestions(valid({ media: { type: "image", src: "/test.png" } }));
			expect(result.questions[0].media).toBeDefined();
		});

		it("accepts table media", () => {
			const result = validateQuestions(valid({
				media: { type: "table", table: { headers: ["A"], rows: [["1"]] } },
			}));
			expect(result.questions[0].media).toBeDefined();
		});

		it("accepts mermaid media", () => {
			const result = validateQuestions(valid({
				media: { type: "mermaid", mermaid: "graph LR\n  A-->B" },
			}));
			expect(result.questions[0].media).toBeDefined();
		});

		it("accepts chart media", () => {
			const result = validateQuestions(valid({
				media: {
					type: "chart",
					chart: { type: "bar", data: { labels: ["A"], datasets: [] } },
				},
			}));
			expect(result.questions[0].media).toBeDefined();
		});

		it("accepts html media", () => {
			const result = validateQuestions(valid({
				media: { type: "html", html: "<p>Hello</p>" },
			}));
			expect(result.questions[0].media).toBeDefined();
		});

		it("accepts media array", () => {
			const result = validateQuestions(valid({
				media: [
					{ type: "image", src: "/a.png" },
					{ type: "mermaid", mermaid: "graph LR\n  A-->B" },
				],
			}));
			expect(Array.isArray(result.questions[0].media)).toBe(true);
		});

		it("accepts position field", () => {
			const result = validateQuestions(valid({
				media: { type: "image", src: "/a.png", position: "side" },
			}));
			expect(result.questions[0].media).toBeDefined();
		});

		it("rejects invalid media type", () => {
			expect(() => validateQuestions(valid({ media: { type: "video" } }))).toThrow(
				"media.type must be one of"
			);
		});

		it("rejects image without src", () => {
			expect(() => validateQuestions(valid({ media: { type: "image" } }))).toThrow(
				"media.src required"
			);
		});

		it("rejects chart without chart object", () => {
			expect(() => validateQuestions(valid({ media: { type: "chart" } }))).toThrow(
				"media.chart required"
			);
		});

		it("rejects chart without chart.type", () => {
			expect(() => validateQuestions(valid({
				media: { type: "chart", chart: { data: {} } },
			}))).toThrow("media.chart.type must be a string");
		});

		it("rejects chart without chart.data", () => {
			expect(() => validateQuestions(valid({
				media: { type: "chart", chart: { type: "bar" } },
			}))).toThrow("media.chart.data must be an object");
		});

		it("rejects mermaid without string", () => {
			expect(() => validateQuestions(valid({ media: { type: "mermaid" } }))).toThrow(
				"media.mermaid required"
			);
		});

		it("rejects table without table object", () => {
			expect(() => validateQuestions(valid({ media: { type: "table" } }))).toThrow(
				"media.table required"
			);
		});

		it("rejects table without headers", () => {
			expect(() => validateQuestions(valid({
				media: { type: "table", table: { rows: [] } },
			}))).toThrow("media.table.headers must be an array");
		});

		it("rejects table without rows", () => {
			expect(() => validateQuestions(valid({
				media: { type: "table", table: { headers: ["A"] } },
			}))).toThrow("media.table.rows must be an array");
		});

		it("rejects html without string", () => {
			expect(() => validateQuestions(valid({ media: { type: "html" } }))).toThrow(
				"media.html required"
			);
		});

		it("rejects invalid position", () => {
			expect(() => validateQuestions(valid({
				media: { type: "image", src: "/a.png", position: "left" },
			}))).toThrow("media.position must be one of");
		});

		it("rejects non-object media", () => {
			expect(() => validateQuestions(valid({ media: "image" }))).toThrow(
				"media must be an object"
			);
		});
	});

	describe("content", () => {
		it("accepts code content", () => {
			const result = validateQuestions(valid({
				content: { source: "const x = 1;", lang: "ts" },
			}));
			expect(result.questions[0].content?.source).toBe("const x = 1;");
		});

		it("rejects legacy question codeBlock field", () => {
			expect(() => validateQuestions(valid({
				codeBlock: { code: "const x = 1;", lang: "ts" },
			}))).toThrow('legacy "codeBlock" is no longer supported; use "content"');
		});

		it("rejects content without source", () => {
			expect(() => validateQuestions(valid({ content: { lang: "ts" } }))).toThrow(
				"content.source must be a string"
			);
		});

		it("rejects non-string content.lang", () => {
			expect(() => validateQuestions(valid({ content: { source: "x", lang: 42 } }))).toThrow(
				"content.lang must be a string"
			);
		});

		it("accepts code content with highlights", () => {
			const result = validateQuestions(valid({
				content: { source: "a\nb\nc", lang: "ts", highlights: [1, 3] },
			}));
			expect(result.questions[0].content?.highlights).toEqual([1, 3]);
		});

		it("rejects non-number highlights", () => {
			expect(() => validateQuestions(valid({
				content: { source: "x", lang: "ts", highlights: ["a"] },
			}))).toThrow("highlights must be an array of numbers");
		});

		it("defaults markdown to preview by allowing showSource omission", () => {
			const result = validateQuestions(valid({
				content: { source: "# Heading", lang: "md" },
			}));
			expect(result.questions[0].content?.lang).toBe("md");
			expect(result.questions[0].content?.showSource).toBeUndefined();
		});

		it("allows markdown showSource override", () => {
			const result = validateQuestions(valid({
				content: { source: "# Heading", lang: "markdown", showSource: true },
			}));
			expect(result.questions[0].content?.showSource).toBe(true);
		});

		it("rejects markdown content with lines", () => {
			expect(() => validateQuestions(valid({
				content: { source: "# Heading", lang: "md", lines: "1-3" },
			}))).toThrow("content.lines is not allowed for markdown content");
		});

		it("rejects markdown content with highlights", () => {
			expect(() => validateQuestions(valid({
				content: { source: "# Heading", lang: "md", highlights: [1] },
			}))).toThrow("content.highlights is not allowed for markdown content");
		});

		it("rejects showSource on non-markdown content", () => {
			expect(() => validateQuestions(valid({
				content: { source: "const x = 1", lang: "ts", showSource: true },
			}))).toThrow('content.showSource is only valid when content.lang is "md" or "markdown"');
		});
	});

	describe("combinations", () => {
		it("accepts critical info with media", () => {
			const result = validateQuestions({
				questions: [{
					id: "q1", type: "info", question: "Architecture",
					weight: "critical",
					media: { type: "mermaid", mermaid: "graph LR\n  A-->B" },
				}],
			});
			expect(result.questions[0].weight).toBe("critical");
		});

		it("accepts minor single with recommended and slight conviction", () => {
			const result = validateQuestions(valid({
				weight: "minor", recommended: "A", conviction: "slight",
			}));
			expect(result.questions[0].weight).toBe("minor");
			expect(result.questions[0].conviction).toBe("slight");
		});

		it("accepts all features together", () => {
			const result = validateQuestions({
				title: "Full Test",
				description: "Every feature",
				questions: [{
					id: "q1", type: "multi", question: "Pick?",
					options: [{ label: "A", content: { source: "a()", lang: "ts" } }, "B", "C"],
					recommended: ["A", "C"],
					conviction: "strong",
					weight: "critical",
					context: "Choose wisely",
					content: { source: "example()", lang: "ts" },
					media: [
						{ type: "table", table: { headers: ["X"], rows: [["1"]], highlights: [0] }, position: "side" },
						{ type: "image", src: "/test.png", alt: "test", caption: "Figure 1" },
					],
				}],
			});
			expect(result.questions[0].options).toHaveLength(3);
			expect(result.questions[0].recommended).toEqual(["A", "C"]);
		});
	});
});

describe("getOptionLabel", () => {
	it("returns string option as-is", () => {
		expect(getOptionLabel("hello")).toBe("hello");
	});

	it("returns label from rich option", () => {
		expect(getOptionLabel({ label: "test", content: { source: "x", lang: "ts" } })).toBe("test");
	});
});

describe("isRichOption", () => {
	it("returns false for string", () => {
		expect(isRichOption("hello")).toBe(false);
	});

	it("returns true for object with label", () => {
		expect(isRichOption({ label: "test" })).toBe(true);
	});
});

describe("sanitizeLLMJSON", () => {
	const VALID_JSON = '{"title":"Test","questions":[{"id":"q1","type":"text","question":"Name?"}]}';

	it("passes valid JSON through unchanged", () => {
		expect(JSON.parse(sanitizeLLMJSON(VALID_JSON))).toEqual(JSON.parse(VALID_JSON));
	});

	describe("code fences", () => {
		it("strips ```json fences", () => {
			const input = '```json\n{"a": 1}\n```';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});

		it("strips bare ``` fences", () => {
			const input = '```\n{"a": 1}\n```';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});

		it("strips ```jsonc fences", () => {
			const input = '```jsonc\n{"a": 1}\n```';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});

		it("handles extra backticks", () => {
			const input = '````json\n{"a": 1}\n````';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});

		it("is case-insensitive for language tag", () => {
			const input = '```JSON\n{"a": 1}\n```';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});
	});

	describe("trailing commas", () => {
		it("removes trailing comma before }", () => {
			const input = '{"a": 1, "b": 2,}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1, b: 2 });
		});

		it("removes trailing comma before ]", () => {
			const input = '{"items": ["x", "y",]}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ items: ["x", "y"] });
		});

		it("handles trailing comma with whitespace/newlines", () => {
			const input = '{\n  "a": 1,\n  "b": 2,\n}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1, b: 2 });
		});

		it("handles nested trailing commas", () => {
			const input = '{"outer": {"inner": 1,}, "arr": [1, 2,],}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ outer: { inner: 1 }, arr: [1, 2] });
		});
	});

	describe("comments", () => {
		it("removes single-line comments on their own lines", () => {
			const input = '{\n  // this is a comment\n  "a": 1\n}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});

		it("removes indented comments", () => {
			const input = '{\n    // indented comment\n    "a": 1\n}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});

		it("does not strip // inside string values", () => {
			const input = '{"url": "https://example.com"}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ url: "https://example.com" });
		});
	});

	describe("smart quotes", () => {
		it("replaces left/right double curly quotes", () => {
			const input = '{\u201Ca\u201D: 1}';
			expect(JSON.parse(sanitizeLLMJSON(input))).toEqual({ a: 1 });
		});
	});

	describe("combined repairs", () => {
		it("handles code fences + trailing commas + comments", () => {
			const input = '```json\n{\n  // Pick a framework\n  "title": "Setup",\n  "questions": [\n    {"id": "q1", "type": "text", "question": "Name?",},\n  ],\n}\n```';
			const result = JSON.parse(sanitizeLLMJSON(input));
			expect(result.title).toBe("Setup");
			expect(result.questions[0].id).toBe("q1");
		});

		it("realistic LLM output with all quirks", () => {
			const input = `\`\`\`json
{
  // Project configuration
  "title": "Project Setup",
  "description": "Review my suggestions",
  "questions": [
    {
      "id": "framework",
      "type": "single",
      "question": "Which framework?",
      "options": ["React", "Vue", "Svelte",],
      "recommended": "React",
    },
    {
      "id": "notes",
      "type": "text",
      "question": "Additional notes?",
    },
  ],
}
\`\`\``;
			const result = JSON.parse(sanitizeLLMJSON(input));
			expect(result.title).toBe("Project Setup");
			expect(result.questions).toHaveLength(2);
			expect(result.questions[0].options).toEqual(["React", "Vue", "Svelte"]);
		});
	});
});
