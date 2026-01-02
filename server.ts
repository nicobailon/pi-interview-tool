import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Question, QuestionsFile } from "./schema.js";

function getGitBranch(cwd: string): string | null {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return branch || null;
	} catch {
		return null;
	}
}

function normalizePath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	return path;
}

export interface ResponseItem {
	id: string;
	value: string | string[];
	attachments?: string[];
}

export interface InterviewServerOptions {
	questions: QuestionsFile;
	sessionToken: string;
	sessionId: string;
	cwd: string;
	timeout: number;
	verbose?: boolean;
	theme?: InterviewThemeConfig;
}

export interface InterviewServerCallbacks {
	onSubmit: (responses: ResponseItem[]) => void;
	onCancel: () => void;
}

export interface InterviewServerHandle {
	server: http.Server;
	url: string;
	close: () => void;
}

export type ThemeMode = "auto" | "light" | "dark";

export interface InterviewThemeConfig {
	mode?: ThemeMode;
	name?: string;
	lightPath?: string;
	darkPath?: string;
	toggleHotkey?: string;
}

const MAX_BODY_SIZE = 15 * 1024 * 1024;
const MAX_IMAGES = 12;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const FORM_DIR = join(dirname(fileURLToPath(import.meta.url)), "form");
const TEMPLATE = readFileSync(join(FORM_DIR, "index.html"), "utf-8");
const STYLES = readFileSync(join(FORM_DIR, "styles.css"), "utf-8");
const SCRIPT = readFileSync(join(FORM_DIR, "script.js"), "utf-8");
const THEMES_DIR = join(FORM_DIR, "themes");
const BUILTIN_THEMES = new Map<string, { light: string; dark: string }>([
	[
		"default",
		{
			light: readFileSync(join(THEMES_DIR, "default-light.css"), "utf-8"),
			dark: readFileSync(join(THEMES_DIR, "default-dark.css"), "utf-8"),
		},
	],
	[
		"tufte",
		{
			light: readFileSync(join(THEMES_DIR, "tufte-light.css"), "utf-8"),
			dark: readFileSync(join(THEMES_DIR, "tufte-dark.css"), "utf-8"),
		},
	],
]);

class BodyTooLargeError extends Error {
	statusCode = 413;
}

function log(verbose: boolean | undefined, message: string) {
	if (verbose) {
		process.stderr.write(`[interview] ${message}\n`);
	}
}

function safeInlineJSON(data: unknown): string {
	return JSON.stringify(data)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

function normalizeThemeMode(mode?: string): ThemeMode | undefined {
	if (mode === "auto" || mode === "light" || mode === "dark") return mode;
	return undefined;
}

function sendText(res: ServerResponse, status: number, text: string) {
	res.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(text);
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(payload));
}

async function parseJSONBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		let size = 0;

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_SIZE) {
				req.destroy();
				reject(new BodyTooLargeError("Request body too large"));
				return;
			}
			body += chunk.toString();
		});

		req.on("end", () => {
			try {
				resolve(JSON.parse(body));
			} catch {
				reject(new Error("Invalid JSON"));
			}
		});

		req.on("error", reject);
	});
}

async function handleImageUpload(
	image: { id: string; filename: string; mimeType: string; data: string },
	sessionId: string
): Promise<string> {
	if (!ALLOWED_TYPES.includes(image.mimeType)) {
		throw new Error(`Invalid image type: ${image.mimeType}`);
	}

	const buffer = Buffer.from(image.data, "base64");
	if (buffer.length > MAX_IMAGE_SIZE) {
		throw new Error("Image exceeds 5MB limit");
	}

	const sanitized = image.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
	const basename = sanitized.split(/[/\\]/).pop() || `image_${randomUUID()}`;
	const extMap: Record<string, string> = {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
	};
	const ext = extMap[image.mimeType] ?? "";
	const filename = basename.includes(".") ? basename : `${basename}${ext}`;

	const tempDir = join(tmpdir(), `pi-interview-${sessionId}`);
	await mkdir(tempDir, { recursive: true });

	const filepath = join(tempDir, filename);
	await writeFile(filepath, buffer);

	return filepath;
}

function validateTokenQuery(url: URL, expectedToken: string, res: ServerResponse): boolean {
	const token = url.searchParams.get("session");
	if (token !== expectedToken) {
		sendText(res, 403, "Invalid session");
		return false;
	}
	return true;
}

function validateTokenBody(body: unknown, expectedToken: string, res: ServerResponse): boolean {
	if (!body || typeof body !== "object") {
		sendJson(res, 400, { ok: false, error: "Invalid request body" });
		return false;
	}
	const token = (body as { token?: string }).token;
	if (token !== expectedToken) {
		sendJson(res, 403, { ok: false, error: "Invalid session" });
		return false;
	}
	return true;
}

function ensureQuestionId(
	id: string,
	questionById: Map<string, Question>
): { ok: true; question: Question } | { ok: false; error: string } {
	const question = questionById.get(id);
	if (!question) {
		return { ok: false, error: `Unknown question id: ${id}` };
	}
	return { ok: true, question };
}

export async function startInterviewServer(
	options: InterviewServerOptions,
	callbacks: InterviewServerCallbacks
): Promise<InterviewServerHandle> {
	const { questions, sessionToken, sessionId, cwd, timeout, verbose } = options;
	const questionById = new Map<string, Question>();
	for (const question of questions.questions) {
		questionById.set(question.id, question);
	}

	const themeConfig = options.theme ?? {};
	const resolvedThemeName =
		themeConfig.name && BUILTIN_THEMES.has(themeConfig.name) ? themeConfig.name : "default";
	if (themeConfig.name && !BUILTIN_THEMES.has(themeConfig.name)) {
		log(verbose, `Unknown theme "${themeConfig.name}", using "default"`);
	}
	const builtinTheme = BUILTIN_THEMES.get(resolvedThemeName) ?? BUILTIN_THEMES.get("default");
	if (!builtinTheme) {
		throw new Error("Missing default theme assets");
	}

	const readThemeFile = (filePath: string, fallback: string, label: string) => {
		try {
			return readFileSync(filePath, "utf-8");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(verbose, `Failed to load ${label} theme from "${filePath}": ${message}`);
			return fallback;
		}
	};

	const themeLightCss = themeConfig.lightPath
		? readThemeFile(themeConfig.lightPath, builtinTheme.light, "light")
		: builtinTheme.light;
	const themeDarkCss = themeConfig.darkPath
		? readThemeFile(themeConfig.darkPath, builtinTheme.dark, "dark")
		: builtinTheme.dark;
	const themeMode = normalizeThemeMode(themeConfig.mode) ?? "dark";

	const server = http.createServer(async (req, res) => {
		try {
			const method = req.method || "GET";
			const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
			log(verbose, `${method} ${url.pathname}`);

			if (method === "GET" && url.pathname === "/") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				const gitBranch = getGitBranch(cwd);
				const inlineData = safeInlineJSON({
					questions: questions.questions,
					title: questions.title,
					description: questions.description,
					sessionToken,
					sessionId,
					cwd: normalizePath(cwd),
					gitBranch,
					startedAt: Date.now(),
					timeout,
					theme: {
						mode: themeMode,
						toggleHotkey: themeConfig.toggleHotkey,
					},
				});
				const html = TEMPLATE
					.replace("/* __INTERVIEW_DATA_PLACEHOLDER__ */", inlineData)
					.replace(/__SESSION_TOKEN__/g, sessionToken);
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(html);
				return;
			}

			if (method === "GET" && url.pathname === "/health") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				sendJson(res, 200, { ok: true });
				return;
			}

			if (method === "GET" && url.pathname === "/styles.css") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				res.writeHead(200, {
					"Content-Type": "text/css; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(STYLES);
				return;
			}

			if (method === "GET" && url.pathname === "/theme-light.css") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				res.writeHead(200, {
					"Content-Type": "text/css; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(themeLightCss);
				return;
			}

			if (method === "GET" && url.pathname === "/theme-dark.css") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				res.writeHead(200, {
					"Content-Type": "text/css; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(themeDarkCss);
				return;
			}

			if (method === "GET" && url.pathname === "/script.js") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				res.writeHead(200, {
					"Content-Type": "application/javascript; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(SCRIPT);
				return;
			}

			if (method === "POST" && url.pathname === "/cancel") {
				const body = await parseJSONBody(req).catch((err) => {
					if (err instanceof BodyTooLargeError) {
						sendJson(res, err.statusCode, { ok: false, error: err.message });
						return null;
					}
					sendJson(res, 400, { ok: false, error: err.message });
					return null;
				});
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				sendJson(res, 200, { ok: true });
				setImmediate(() => callbacks.onCancel());
				return;
			}

			if (method === "POST" && url.pathname === "/submit") {
				const body = await parseJSONBody(req).catch((err) => {
					if (err instanceof BodyTooLargeError) {
						sendJson(res, err.statusCode, { ok: false, error: err.message });
						return null;
					}
					sendJson(res, 400, { ok: false, error: err.message });
					return null;
				});
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;

				const payload = body as {
					responses?: Array<{ id: string; value: string | string[]; attachments?: string[] }>;
					images?: Array<{ id: string; filename: string; mimeType: string; data: string; isAttachment?: boolean }>;
				};

				const responsesInput = Array.isArray(payload.responses) ? payload.responses : [];
				const imagesInput = Array.isArray(payload.images) ? payload.images : [];

				if (imagesInput.length > MAX_IMAGES) {
					sendJson(res, 400, { ok: false, error: `Too many images (max ${MAX_IMAGES})` });
					return;
				}

				const responses: ResponseItem[] = [];
				for (const item of responsesInput) {
					if (!item || typeof item.id !== "string") continue;
					const questionCheck = ensureQuestionId(item.id, questionById);
					if (questionCheck.ok === false) {
						sendJson(res, 400, { ok: false, error: questionCheck.error, field: item.id });
						return;
					}
					const question = questionCheck.question;
					
					const resp: ResponseItem = { id: item.id, value: "" };
					
					if (question.type === "image") {
						if (Array.isArray(item.value) && item.value.every((v) => typeof v === "string")) {
							resp.value = item.value;
						}
					} else if (question.type === "multi") {
						if (!Array.isArray(item.value) || item.value.some((v) => typeof v !== "string")) {
							sendJson(res, 400, {
								ok: false,
								error: `Invalid response value for ${item.id}`,
								field: item.id,
							});
							return;
						}
						resp.value = item.value;
					} else {
						if (typeof item.value !== "string") {
							sendJson(res, 400, {
								ok: false,
								error: `Invalid response value for ${item.id}`,
								field: item.id,
							});
							return;
						}
						resp.value = item.value;
					}
					
					if (Array.isArray(item.attachments) && item.attachments.every((a) => typeof a === "string")) {
						resp.attachments = item.attachments;
					}

					responses.push(resp);
				}

				for (const image of imagesInput) {
					if (!image || typeof image.id !== "string") continue;
					const questionCheck = ensureQuestionId(image.id, questionById);
					if (questionCheck.ok === false) {
						sendJson(res, 400, { ok: false, error: questionCheck.error, field: image.id });
						return;
					}

					if (
						typeof image.filename !== "string" ||
						typeof image.mimeType !== "string" ||
						typeof image.data !== "string"
					) {
						sendJson(res, 400, { ok: false, error: "Invalid image payload", field: image.id });
						return;
					}

					try {
						const filepath = await handleImageUpload(image, sessionId);
						
						const existing = responses.find((r) => r.id === image.id);
						if (image.isAttachment) {
							if (existing) {
								existing.attachments = existing.attachments || [];
								existing.attachments.push(filepath);
							} else {
								responses.push({ id: image.id, value: "", attachments: [filepath] });
							}
						} else {
							if (existing) {
								if (Array.isArray(existing.value)) {
									existing.value.push(filepath);
								} else if (existing.value === "") {
									existing.value = filepath;
								} else {
									existing.value = [existing.value, filepath];
								}
							} else {
								responses.push({ id: image.id, value: filepath });
							}
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : "Image upload failed";
						sendJson(res, 400, { ok: false, error: message, field: image.id });
						return;
					}
				}

				sendJson(res, 200, { ok: true });
				setImmediate(() => callbacks.onSubmit(responses));
				return;
			}

			sendText(res, 404, "Not found");
		} catch (err) {
			const message = err instanceof Error ? err.message : "Server error";
			sendJson(res, 500, { ok: false, error: message });
		}
	});

	return new Promise((resolve, reject) => {
		const onError = (err: Error) => {
			reject(new Error(`Failed to start server: ${err.message}`));
		};

		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError);
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to start server: invalid address"));
				return;
			}
			const url = `http://localhost:${addr.port}/?session=${sessionToken}`;
			resolve({
				server,
				url,
				close: () => {
					try {
						server.close();
					} catch {}
				},
			});
		});
	});
}
