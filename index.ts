import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { CustomTool, CustomToolFactory, CustomToolAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { startInterviewServer, type ResponseItem } from "./server.js";
import { validateQuestions, type QuestionsFile } from "./schema.js";

async function openUrl(pi: CustomToolAPI, url: string, browser?: string): Promise<void> {
	const platform = os.platform();
	let result;
	if (platform === "darwin") {
		if (browser) {
			result = await pi.exec("open", ["-a", browser, url]);
		} else {
			result = await pi.exec("open", [url]);
		}
	} else if (platform === "win32") {
		if (browser) {
			result = await pi.exec("cmd", ["/c", "start", "", browser, url]);
		} else {
			result = await pi.exec("cmd", ["/c", "start", "", url]);
		}
	} else {
		if (browser) {
			result = await pi.exec(browser, [url]);
		} else {
			result = await pi.exec("xdg-open", [url]);
		}
	}
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
	}
}

interface InterviewDetails {
	status: "completed" | "cancelled" | "timeout" | "aborted";
	responses: ResponseItem[];
	url: string;
}

interface InterviewSettings {
	browser?: string;
	timeout?: number;
	theme?: InterviewThemeSettings;
}

type ThemeMode = "auto" | "light" | "dark";

interface InterviewThemeSettings {
	mode?: ThemeMode;
	name?: string;
	lightPath?: string;
	darkPath?: string;
	toggleHotkey?: string;
}

const InterviewParams = Type.Object({
	questions: Type.String({ description: "Path to questions JSON file" }),
	timeout: Type.Optional(
		Type.Number({ description: "Seconds before auto-timeout", default: 600 })
	),
	verbose: Type.Optional(Type.Boolean({ description: "Enable debug logging", default: false })),
	theme: Type.Optional(
		Type.Object(
			{
				mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("light"), Type.Literal("dark")])),
				name: Type.Optional(Type.String()),
				lightPath: Type.Optional(Type.String()),
				darkPath: Type.Optional(Type.String()),
				toggleHotkey: Type.Optional(Type.String()),
			},
			{ additionalProperties: false }
		)
	),
});

function getSettings(): InterviewSettings {
	const settingsPath = path.join(os.homedir(), ".pi/agent/settings.json");
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		return (settings.interview as InterviewSettings) ?? {};
	} catch {
		return {};
	}
}

function expandHome(value: string): string {
	if (value.startsWith("~" + path.sep)) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function resolveOptionalPath(value: string | undefined, cwd: string): string | undefined {
	if (!value) return undefined;
	const expanded = expandHome(value);
	return path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
}

function mergeThemeConfig(
	base: InterviewThemeSettings | undefined,
	override: InterviewThemeSettings | undefined,
	cwd: string
): InterviewThemeSettings | undefined {
	if (!base && !override) return undefined;
	const merged: InterviewThemeSettings = { ...(base ?? {}), ...(override ?? {}) };
	return {
		...merged,
		lightPath: resolveOptionalPath(merged.lightPath, cwd),
		darkPath: resolveOptionalPath(merged.darkPath, cwd),
	};
}

function loadQuestions(questionsPath: string, cwd: string): QuestionsFile {
	const absolutePath = path.isAbsolute(questionsPath)
		? questionsPath
		: path.join(cwd, questionsPath);

	if (!fs.existsSync(absolutePath)) {
		throw new Error(`Questions file not found: ${absolutePath}`);
	}

	let data: unknown;
	try {
		const content = fs.readFileSync(absolutePath, "utf-8");
		data = JSON.parse(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid JSON in questions file: ${message}`);
	}

	return validateQuestions(data);
}

function formatResponses(responses: ResponseItem[]): string {
	if (responses.length === 0) return "(none)";
	return responses
		.map((resp) => {
			const value = Array.isArray(resp.value) ? resp.value.join(", ") : resp.value;
			let line = `- ${resp.id}: ${value}`;
			if (resp.attachments && resp.attachments.length > 0) {
				line += ` [attachments: ${resp.attachments.join(", ")}]`;
			}
			return line;
		})
		.join("\n");
}

const factory: CustomToolFactory = (pi) => {
	const tool: CustomTool<typeof InterviewParams, InterviewDetails> = {
		name: "interview",
		label: "Interview",
		description:
			"Present an interactive form to gather user responses to questions. Image responses and attachments are returned as file paths - use the read tool directly to display them (no need to verify with file command first).",
		parameters: InterviewParams,

		async execute(_toolCallId, params, _onUpdate, ctx, signal) {
			const { questions, timeout, verbose, theme } = params as {
				questions: string;
				timeout?: number;
				verbose?: boolean;
				theme?: InterviewThemeSettings;
			};

			if (!pi.hasUI) {
				throw new Error(
					"Interview tool requires interactive mode with browser support. " +
						"Cannot run in headless/RPC/print mode."
				);
			}

			if (typeof ctx.hasQueuedMessages === "function" && ctx.hasQueuedMessages()) {
				return {
					content: [{ type: "text", text: "Interview skipped - user has queued input." }],
					details: { status: "cancelled", url: "", responses: [] },
				};
			}

			const settings = getSettings();
			const timeoutSeconds = timeout ?? settings.timeout ?? 600;
			const themeConfig = mergeThemeConfig(settings.theme, theme, pi.cwd);
			const questionsData = loadQuestions(questions, pi.cwd);

			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Interview was aborted." }],
					details: { status: "aborted", url: "", responses: [] },
				};
			}

			const sessionId = randomUUID();
			const sessionToken = randomUUID();
			let server: { close: () => void } | null = null;
			let timeoutId: NodeJS.Timeout | null = null;
			let resolved = false;
			let url = "";

			const cleanup = () => {
				if (timeoutId) {
					clearTimeout(timeoutId);
					timeoutId = null;
				}
				if (server) {
					server.close();
					server = null;
				}
			};

			return new Promise((resolve, reject) => {
				const finish = (status: InterviewDetails["status"], responses: ResponseItem[] = []) => {
					if (resolved) return;
					resolved = true;
					cleanup();

					let text = "";
					if (status === "completed") {
						text = `User completed the interview form.\n\nResponses:\n${formatResponses(responses)}`;
					} else if (status === "cancelled") {
						text = "User cancelled the interview form.";
					} else if (status === "timeout") {
						text = `Interview form timed out after ${timeoutSeconds} seconds.`;
					} else {
						text = "Interview was aborted.";
					}

					resolve({
						content: [{ type: "text", text }],
						details: { status, url, responses },
					});
				};

				const handleAbort = () => finish("aborted");
				signal?.addEventListener("abort", handleAbort, { once: true });

				startInterviewServer(
					{
						questions: questionsData,
						sessionToken,
						sessionId,
						cwd: pi.cwd,
						timeout: timeoutSeconds,
						verbose,
						theme: themeConfig,
					},
					{
						onSubmit: (responses) => finish("completed", responses),
						onCancel: () => finish("cancelled"),
					}
				)
					.then(async (handle) => {
						server = handle;
						url = handle.url;

						try {
							await openUrl(pi, url, settings.browser);
						} catch (err) {
							cleanup();
							const message = err instanceof Error ? err.message : String(err);
							reject(new Error(`Failed to open browser: ${message}`));
							return;
						}

						if (timeoutSeconds > 0) {
							const timeoutMs = timeoutSeconds * 1000;
							timeoutId = setTimeout(() => finish("timeout"), timeoutMs);
						}
					})
					.catch((err) => {
						cleanup();
						reject(err);
					});
			});
		},

		renderCall(args, theme) {
			const { questions } = args as { questions?: string };
			const label = questions ? `Interview: ${questions}` : "Interview";
			return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as InterviewDetails | undefined;
			if (!details) return new Text("Interview", 0, 0);

			const statusColor =
				details.status === "completed"
					? "success"
					: details.status === "cancelled"
						? "warning"
						: details.status === "timeout"
							? "warning"
							: "error";

			const line = `${details.status.toUpperCase()} (${details.responses.length} responses)`;
			return new Text(theme.fg(statusColor, line), 0, 0);
		},
	};

	return tool;
};

export default factory;
