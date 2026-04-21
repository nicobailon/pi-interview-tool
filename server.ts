import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getOptionLabel, type Question, type QuestionsFile, type MediaBlock, type OptionValue } from "./schema.js";

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

interface SessionEntry {
	id: string;
	url: string;
	cwd: string;
	gitBranch: string | null;
	title: string;
	startedAt: number;
	lastSeen: number;
}

interface SessionsFile {
	sessions: SessionEntry[];
}

const SESSIONS_FILE = join(homedir(), ".pi", "interview-sessions.json");
const RECOVERY_DIR = join(homedir(), ".pi", "interview-recovery");
const SNAPSHOTS_DIR = join(homedir(), ".pi", "interview-snapshots");
const STALE_THRESHOLD_MS = 30000;
const STALE_PRUNE_MS = 60000;
const RECOVERY_MAX_AGE_DAYS = 7;
const ABANDONED_GRACE_MS = 60000;
const WATCHDOG_INTERVAL_MS = 5000;

function ensurePiDir(): void {
	const piDir = join(homedir(), ".pi");
	if (!existsSync(piDir)) {
		mkdirSync(piDir, { recursive: true });
	}
}

function readSessions(): SessionsFile {
	try {
		if (!existsSync(SESSIONS_FILE)) {
			return { sessions: [] };
		}
		const data = readFileSync(SESSIONS_FILE, "utf8");
		const parsed = JSON.parse(data);
		if (!parsed.sessions || !Array.isArray(parsed.sessions)) {
			return { sessions: [] };
		}
		return parsed as SessionsFile;
	} catch {
		return { sessions: [] };
	}
}

function listSessions(): SessionEntry[] {
	const data = readSessions();
	const pruned = pruneStale(data.sessions);
	if (pruned.length !== data.sessions.length) {
		writeSessions({ sessions: pruned });
	}
	return pruned;
}

function writeSessions(data: SessionsFile): void {
	ensurePiDir();
	const tempFile = SESSIONS_FILE + ".tmp";
	writeFileSync(tempFile, JSON.stringify(data, null, 2));
	renameSync(tempFile, SESSIONS_FILE);
}

function pruneStale(sessions: SessionEntry[]): SessionEntry[] {
	const now = Date.now();
	return sessions.filter((s) => now - s.lastSeen < STALE_PRUNE_MS);
}

function touchSession(entry: SessionEntry): void {
	const data = readSessions();
	data.sessions = pruneStale(data.sessions);
	const existing = data.sessions.find((s) => s.id === entry.id);
	if (existing) {
		existing.lastSeen = Date.now();
		existing.url = entry.url;
		existing.cwd = entry.cwd;
		existing.gitBranch = entry.gitBranch;
		existing.title = entry.title;
		existing.startedAt = entry.startedAt;
	} else {
		data.sessions.push({ ...entry, lastSeen: Date.now() });
	}
	writeSessions(data);
}

function registerSession(entry: SessionEntry): void {
	touchSession(entry);
}

function unregisterSession(sessionId: string): void {
	const data = readSessions();
	data.sessions = data.sessions.filter((s) => s.id !== sessionId);
	writeSessions(data);
}

export function getActiveSessions(): SessionEntry[] {
	const pruned = listSessions();
	const now = Date.now();
	return pruned.filter((s) => now - s.lastSeen < STALE_THRESHOLD_MS);
}

function ensureRecoveryDir(): void {
	if (!existsSync(RECOVERY_DIR)) {
		mkdirSync(RECOVERY_DIR, { recursive: true });
	}
}

function cleanupOldRecoveryFiles(): void {
	if (!existsSync(RECOVERY_DIR)) return;
	const now = Date.now();
	const maxAge = RECOVERY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
	try {
		const files = readdirSync(RECOVERY_DIR);
		for (const file of files) {
			const filePath = join(RECOVERY_DIR, file);
			const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})_/);
			if (dateMatch) {
				const fileDate = new Date(dateMatch[1]).getTime();
				if (now - fileDate > maxAge) {
					unlinkSync(filePath);
				}
			}
		}
	} catch {}
}

function sanitizeForFilename(str: string): string {
	return str.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 50);
}

function saveToRecovery(
	questions: QuestionsFile,
	cwd: string,
	gitBranch: string | null,
	sessionId: string
): string {
	ensureRecoveryDir();
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
	const project = sanitizeForFilename(basename(cwd) || "unknown");
	const branch = sanitizeForFilename(gitBranch || "nogit");
	const shortId = sessionId.slice(0, 8);
	const filename = `${date}_${time}_${project}_${branch}_${shortId}.json`;
	const filePath = join(RECOVERY_DIR, filename);
	writeFileSync(filePath, JSON.stringify(questions, null, 2));
	return filePath;
}

export interface ChoiceResponseValue {
	option: string;
	note?: string;
}

export type ResponseValue = string | string[] | ChoiceResponseValue | ChoiceResponseValue[];

export interface ResponseItem {
	id: string;
	value: ResponseValue;
	attachments?: string[];
}

export interface SavedOptionInsight {
	id: string;
	questionId: string;
	optionKey: string;
	optionText: string;
	prompt: string;
	summary: string;
	bullets?: string[];
	suggestedText?: string;
	modelUsed?: string | null;
	createdAt?: string;
}

export interface AskModelOption {
	value: string;
	provider: string;
	label: string;
}

export interface OptionInsightResult {
	summary: string;
	bullets?: string[];
	suggestedText?: string;
	modelUsed?: string | null;
}

export interface InterviewServerOptions {
	questions: QuestionsFile;
	sessionToken: string;
	sessionId: string;
	cwd: string;
	timeout: number;
	port?: number;
	verbose?: boolean;
	theme?: InterviewThemeConfig;
	snapshotDir?: string;
	autoSaveOnSubmit?: boolean;
	savedAnswers?: ResponseItem[];
	savedOptionInsights?: SavedOptionInsight[];
	optionKeysByQuestion?: Record<string, string[]>;
	canGenerate?: boolean;
	askModels?: AskModelOption[];
	defaultAskModel?: string | null;
}

export interface InterviewServerCallbacks {
	onSubmit: (responses: ResponseItem[]) => void;
	onCancel: (reason?: "timeout" | "user" | "stale", partialResponses?: ResponseItem[]) => void;
	onGenerate?: (
		questionId: string,
		existingOptions: string[],
		signal: AbortSignal,
		mode: "add" | "review",
	) => Promise<{ options: OptionValue[]; question?: string }>;
	onOptionInsight?: (
		questionId: string,
		option: OptionValue,
		prompt: string,
		modelOverride: string | null,
		signal: AbortSignal,
	) => Promise<OptionInsightResult>;
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
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				reject(new Error(`Invalid JSON: ${message}`));
			}
		});

		req.on("error", reject);
	});
}

async function handleImageUpload(
	image: { id: string; filename: string; mimeType: string; data: string },
	sessionId: string,
	targetDir?: string
): Promise<string> {
	if (!ALLOWED_TYPES.includes(image.mimeType)) {
		throw new Error(`Invalid image type: ${image.mimeType}`);
	}

	const buffer = Buffer.from(image.data, "base64");
	if (buffer.length > MAX_IMAGE_SIZE) {
		throw new Error("Image exceeds 5MB limit");
	}

	const sanitized = image.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
	const fileBasename = sanitized.split(/[/\\]/).pop() || `image_${randomUUID()}`;
	const extMap: Record<string, string> = {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
	};
	const ext = extMap[image.mimeType] ?? "";
	const filename = fileBasename.includes(".") ? fileBasename : `${fileBasename}${ext}`;

	const dir = targetDir ?? join(tmpdir(), `pi-interview-${sessionId}`);
	await mkdir(dir, { recursive: true });

	const filepath = join(dir, filename);
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

function syncRecommendations(question: Question, options: OptionValue[]): void {
	const optionLabels = options.map((option) => getOptionLabel(option));
	if (!question.recommended) return;

	if (question.type === "single") {
		if (typeof question.recommended === "string" && optionLabels.includes(question.recommended)) {
			return;
		}
		delete question.recommended;
		delete question.conviction;
		return;
	}

	if (question.type !== "multi") {
		delete question.recommended;
		delete question.conviction;
		return;
	}

	const nextRecommended = (Array.isArray(question.recommended)
		? question.recommended
		: [question.recommended]).filter((option) => optionLabels.includes(option));
	if (nextRecommended.length === 0) {
		delete question.recommended;
		delete question.conviction;
		return;
	}
	question.recommended = nextRecommended;
}

function makeOptionKey(): string {
	return `opt-${randomUUID()}`;
}

function buildOptionKeysByQuestion(
	questionsList: Question[],
	initial: Record<string, string[]> | undefined,
): Record<string, string[]> {
	const next: Record<string, string[]> = {};
	for (const question of questionsList) {
		if (question.type !== "single" && question.type !== "multi") continue;
		if (!question.options) continue;
		const existing = initial?.[question.id];
		if (Array.isArray(existing) && existing.length === question.options.length && existing.every((key) => typeof key === "string" && key.trim().length > 0)) {
			next[question.id] = [...existing];
			continue;
		}
		next[question.id] = question.options.map(() => makeOptionKey());
	}
	return next;
}

function getOptionIndexByKey(
	question: Question,
	optionKeysByQuestion: Record<string, string[]>,
	optionKey: string,
): number {
	if ((question.type !== "single" && question.type !== "multi") || !question.options) {
		return -1;
	}
	const keys = optionKeysByQuestion[question.id] ?? [];
	return keys.indexOf(optionKey);
}

function setOptionLabel(option: OptionValue, label: string): OptionValue {
	return typeof option === "string" ? label : { ...option, label };
}

function isChoiceResponseValue(value: unknown): value is ChoiceResponseValue {
	return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as ChoiceResponseValue).option === "string";
}

function normalizeChoiceResponseValue(value: unknown): ChoiceResponseValue | null {
	if (!isChoiceResponseValue(value)) {
		return null;
	}
	const option = value.option.trim();
	if (!option) {
		return null;
	}
	const note = typeof value.note === "string" ? value.note.trim() : "";
	return note ? { option, note } : { option };
}

function cloneResponseValue(value: ResponseValue): ResponseValue {
	if (Array.isArray(value)) {
		return value.map((item) => isChoiceResponseValue(item)
			? { ...item }
			: item);
	}
	if (isChoiceResponseValue(value)) {
		return { ...value };
	}
	return value;
}

function normalizeResponseItem(
	question: Question,
	item: { id?: unknown; value?: unknown; attachments?: unknown },
): { ok: true; response: ResponseItem } | { ok: false; error: string } {
	const response: ResponseItem = { id: question.id, value: "" };

	if (question.type === "image") {
		if (Array.isArray(item.value) && item.value.every((value) => typeof value === "string")) {
			response.value = item.value;
		}
	} else if (question.type === "single") {
		if (item.value === "") {
			response.value = "";
		} else {
			const value = normalizeChoiceResponseValue(item.value);
			if (!value) {
				return { ok: false, error: `Invalid response value for ${question.id}` };
			}
			response.value = value;
		}
	} else if (question.type === "multi") {
		if (!Array.isArray(item.value)) {
			return { ok: false, error: `Invalid response value for ${question.id}` };
		}
		const values: ChoiceResponseValue[] = [];
		for (const value of item.value) {
			const normalized = normalizeChoiceResponseValue(value);
			if (!normalized) {
				return { ok: false, error: `Invalid response value for ${question.id}` };
			}
			values.push(normalized);
		}
		response.value = values;
	} else {
		if (typeof item.value !== "string") {
			return { ok: false, error: `Invalid response value for ${question.id}` };
		}
		response.value = item.value;
	}

	if (Array.isArray(item.attachments) && item.attachments.every((attachment) => typeof attachment === "string")) {
		response.attachments = item.attachments;
	}

	return { ok: true, response };
}

function normalizeResponseItems(
	responsesInput: unknown[],
	questionById: Map<string, Question>,
): { ok: true; responses: ResponseItem[] } | { ok: false; field?: string; error: string } {
	const responses: ResponseItem[] = [];
	for (const item of responsesInput) {
		if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") continue;
		const typedItem = item as { id: string; value?: unknown; attachments?: unknown };
		const questionCheck = ensureQuestionId(typedItem.id, questionById);
		if (questionCheck.ok === false) {
			return { ok: false, error: questionCheck.error, field: typedItem.id };
		}
		const normalized = normalizeResponseItem(questionCheck.question, typedItem);
		if (normalized.ok === false) {
			return { ok: false, error: normalized.error, field: typedItem.id };
		}
		responses.push(normalized.response);
	}
	return { ok: true, responses };
}

function normalizeGeneratedOptionValues(options: OptionValue[]): OptionValue[] {
	const uniqueOptions: OptionValue[] = [];
	const indexByLabel = new Map<string, number>();
	for (const option of options) {
		const label = getOptionLabel(option).trim();
		if (!label) continue;
		const normalizedOption = setOptionLabel(option, label);
		const labelKey = label.toLowerCase();
		const existingIndex = indexByLabel.get(labelKey);
		if (existingIndex === undefined) {
			indexByLabel.set(labelKey, uniqueOptions.length);
			uniqueOptions.push(normalizedOption);
			continue;
		}
		if (typeof uniqueOptions[existingIndex] === "string" && typeof normalizedOption !== "string") {
			uniqueOptions[existingIndex] = normalizedOption;
		}
	}
	return uniqueOptions;
}

function reconcileOptionKeysByLabel(
	previousOptions: OptionValue[],
	previousKeys: string[],
	nextOptions: OptionValue[],
): string[] {
	const availableKeysByLabel = new Map<string, string[]>();
	for (let index = 0; index < previousOptions.length; index++) {
		const key = previousKeys[index];
		if (!key) continue;
		const label = getOptionLabel(previousOptions[index]).trim();
		const existing = availableKeysByLabel.get(label);
		if (existing) {
			existing.push(key);
			continue;
		}
		availableKeysByLabel.set(label, [key]);
	}

	return nextOptions.map((option) => {
		const matchingKeys = availableKeysByLabel.get(getOptionLabel(option).trim());
		if (!matchingKeys || matchingKeys.length === 0) {
			return makeOptionKey();
		}
		return matchingKeys.shift() ?? makeOptionKey();
	});
}

function normalizeSavedOptionInsights(input: unknown): SavedOptionInsight[] {
	if (!Array.isArray(input)) return [];
	const normalized: SavedOptionInsight[] = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		if (
			typeof raw.id !== "string" ||
			typeof raw.questionId !== "string" ||
			typeof raw.optionKey !== "string" ||
			typeof raw.optionText !== "string" ||
			typeof raw.prompt !== "string" ||
			typeof raw.summary !== "string"
		) {
			continue;
		}
		const bullets = Array.isArray(raw.bullets)
			? raw.bullets.filter((bullet): bullet is string => typeof bullet === "string" && bullet.trim().length > 0)
			: undefined;
		normalized.push({
			id: raw.id,
			questionId: raw.questionId,
			optionKey: raw.optionKey,
			optionText: raw.optionText,
			prompt: raw.prompt,
			summary: raw.summary,
			bullets: bullets && bullets.length > 0 ? bullets : undefined,
			suggestedText: typeof raw.suggestedText === "string" ? raw.suggestedText : undefined,
			modelUsed: typeof raw.modelUsed === "string" ? raw.modelUsed : raw.modelUsed === null ? null : undefined,
			createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
		});
	}
	return normalized;
}

function renderSavedOptionInsightsHtml(insights: SavedOptionInsight[]): string {
	if (insights.length === 0) return "";
	return `<div class="saved-option-insights">${insights.map((insight) => {
		const bulletsHtml = insight.bullets && insight.bullets.length > 0
			? `<ul>${insight.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
			: "";
		const suggestionHtml = insight.suggestedText
			? `<div class="saved-option-insight-suggestion"><span>Suggested rewrite</span><code>${escapeHtml(insight.suggestedText)}</code></div>`
			: "";
		const metaParts = [
			insight.optionText ? `Option: ${escapeHtml(insight.optionText)}` : "",
			insight.modelUsed ? `Model: ${escapeHtml(insight.modelUsed)}` : "",
		].filter(Boolean);
		return `<article class="saved-option-insight">
			<div class="saved-option-insight-prompt">${escapeHtml(insight.prompt)}</div>
			${metaParts.length > 0 ? `<div class="saved-option-insight-meta">${metaParts.join(" · ")}</div>` : ""}
			<p>${escapeHtml(insight.summary)}</p>
			${bulletsHtml}
			${suggestionHtml}
		</article>`;
	}).join("")}</div>`;
}

// HTML generation for saved interviews
interface SavedFromMeta {
	cwd: string;
	branch: string | null;
	sessionId: string;
}

interface SavedInterviewMeta {
	savedAt: string;
	wasSubmitted: boolean;
	savedFrom: SavedFromMeta;
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function isMarkdownLang(lang: string | undefined): boolean {
	if (!lang) return false;
	const normalized = lang.trim().toLowerCase();
	return normalized === "md" || normalized === "markdown";
}

function renderLightMarkdownHtml(text: string): string {
	let html = escapeHtml(text);
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\n/g, "<br>");
	html = html.replace(/\s(\d+\.)\s/g, "<br>$1 ");
	return html;
}

function renderMarkdownPreviewHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const html: string[] = [];
	const paragraph: string[] = [];
	let listType: "ul" | "ol" | null = null;
	let inFence = false;
	let fenceLang = "";
	let fenceLines: string[] = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${renderLightMarkdownHtml(paragraph.join(" "))}</p>`);
		paragraph.length = 0;
	};

	const closeList = () => {
		if (!listType) return;
		html.push(listType === "ol" ? "</ol>" : "</ul>");
		listType = null;
	};

	for (const rawLine of lines) {
		const line = rawLine ?? "";

		if (inFence) {
			if (/^```/.test(line.trim())) {
				html.push(`<pre class="markdown-fence"><code${fenceLang ? ` data-lang="${escapeHtml(fenceLang)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
				inFence = false;
				fenceLang = "";
				fenceLines = [];
			} else {
				fenceLines.push(line);
			}
			continue;
		}

		const fenceStart = line.match(/^```\s*([^\s`]*)\s*$/);
		if (fenceStart) {
			flushParagraph();
			closeList();
			inFence = true;
			fenceLang = fenceStart[1] || "";
			fenceLines = [];
			continue;
		}

		if (!line.trim()) {
			flushParagraph();
			closeList();
			continue;
		}

		const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
		if (headingMatch) {
			flushParagraph();
			closeList();
			const level = headingMatch[1].length;
			html.push(`<h${level}>${renderLightMarkdownHtml(headingMatch[2].trim())}</h${level}>`);
			continue;
		}

		const quoteMatch = line.match(/^>\s?(.*)$/);
		if (quoteMatch) {
			flushParagraph();
			closeList();
			html.push(`<blockquote><p>${renderLightMarkdownHtml(quoteMatch[1])}</p></blockquote>`);
			continue;
		}

		const orderedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
		if (orderedMatch) {
			flushParagraph();
			if (listType !== "ol") {
				closeList();
				html.push("<ol>");
				listType = "ol";
			}
			html.push(`<li>${renderLightMarkdownHtml(orderedMatch[1])}</li>`);
			continue;
		}

		const unorderedMatch = line.match(/^\s*[-*]\s+(.+)$/);
		if (unorderedMatch) {
			flushParagraph();
			if (listType !== "ul") {
				closeList();
				html.push("<ul>");
				listType = "ul";
			}
			html.push(`<li>${renderLightMarkdownHtml(unorderedMatch[1])}</li>`);
			continue;
		}

		closeList();
		paragraph.push(line.trim());
	}

	if (inFence) {
		html.push(`<pre class="markdown-fence"><code${fenceLang ? ` data-lang="${escapeHtml(fenceLang)}"` : ""}>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
	}

	flushParagraph();
	closeList();
	return html.join("\n");
}

function renderContentBlockHtml(content: Question["content"] | undefined): string {
	if (!content?.source) return "";

	const markdownPreview = isMarkdownLang(content.lang) && content.showSource !== true;
	const headerParts: string[] = [];
	if (content.title) {
		headerParts.push(`<span class="code-block-title">${escapeHtml(content.title)}</span>`);
	}
	if (content.file) {
		headerParts.push(`<span class="code-block-file">${escapeHtml(content.file)}</span>`);
	}
	if (content.lines) {
		headerParts.push(`<span class="code-block-lines">L${escapeHtml(content.lines)}</span>`);
	}
	if (content.lang && content.lang !== "diff") {
		headerParts.push(`<span class="code-block-lang">${escapeHtml(content.lang)}</span>`);
	}
	const headerHtml = headerParts.length > 0
		? `<div class="code-block-header">${headerParts.join("")}</div>`
		: "";

	if (markdownPreview) {
		return `<div class="code-block markdown-content-block">${headerHtml}<div class="markdown-preview">${renderMarkdownPreviewHtml(content.source)}</div></div>`;
	}

	return `<div class="code-block">${headerHtml}<pre class="saved-code"><code>${escapeHtml(content.source)}</code></pre></div>`;
}

function renderMediaCaptionHtml(media: MediaBlock): string {
	if (!media.caption) return "";
	return `<div class="media-caption">${escapeHtml(media.caption)}</div>`;
}

function renderMediaBlockHtml(media: MediaBlock): string {
	const caption = renderMediaCaptionHtml(media);

	switch (media.type) {
		case "image":
			return `<figure class="media-block media-image">
				<img src="${escapeHtml(media.src || "")}" alt="${escapeHtml(media.alt || "")}">
				${caption}</figure>`;
		case "table": {
			if (!media.table) return "";
			const highlights = new Set(media.table.highlights || []);
			const headers = media.table.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("");
			const rows = media.table.rows.map((row, i) => {
				const cls = highlights.has(i) ? ' class="highlighted-row"' : "";
				const cells = row.map(c => `<td>${escapeHtml(c)}</td>`).join("");
				return `<tr${cls}>${cells}</tr>`;
			}).join("\n");
			return `<div class="media-block media-table"><div class="media-table-scroll">
				<table class="data-table"><thead><tr>${headers}</tr></thead>
				<tbody>${rows}</tbody></table></div>${caption}</div>`;
		}
		case "mermaid":
			return `<div class="media-block media-mermaid">
				<pre class="mermaid">${escapeHtml(media.mermaid || "")}</pre>${caption}</div>`;
		case "chart":
			return `<div class="media-block media-chart">
				<div class="media-chart-static">[Chart: ${escapeHtml(media.chart?.type || "unknown")}]</div>
				${caption}</div>`;
		case "html":
			return `<div class="media-block media-html">${media.html || ""}${caption}</div>`;
		default:
			return "";
	}
}

function renderMediaListHtml(media: MediaBlock | MediaBlock[] | undefined): string {
	if (!media) return "";
	const list = Array.isArray(media) ? media : [media];
	return list.map(renderMediaBlockHtml).join("\n");
}

function recommendedIndicatorHtml(q: Question): string {
	if (!q.recommended) return "";
	return '<span class="recommended-pill">Recommended</span>';
}

function savedAnswerItemHtml(text: string, q: Question): string {
	const recs = Array.isArray(q.recommended)
		? q.recommended
		: q.recommended ? [q.recommended] : [];
	const indicator = recs.includes(text) ? " " + recommendedIndicatorHtml(q) : "";
	return escapeHtml(text) + indicator;
}

function savedChoiceAnswerHtml(value: ChoiceResponseValue, question: Question): string {
	const noteHtml = value.note
		? `<div class="saved-answer-note">${escapeHtml(value.note)}</div>`
		: "";
	return `<div class="saved-answer-choice">${savedAnswerItemHtml(value.option, question)}${noteHtml}</div>`;
}

function weightClasses(q: Question): string {
	const classes = ["saved-question"];
	if (q.type === "info") classes.push("info-panel");
	if (q.weight === "critical") classes.push("weight-critical");
	if (q.weight === "minor") classes.push("weight-minor");
	return classes.join(" ");
}

async function copyMediaImages(questionsList: Question[], imagesDir: string, cwd: string): Promise<Question[]> {
	const toCopy: Array<{ src: string; dest: string }> = [];
	const rewritten = questionsList.map(q => {
		if (!q.media) return q;
		const mediaList = Array.isArray(q.media) ? q.media : [q.media];
		let changed = false;
		const newMedia = mediaList.map(m => {
			if (m.type !== "image" || !m.src) return m;
			if (m.src.startsWith("http://") || m.src.startsWith("https://") || m.src.startsWith("data:")) return m;
			const resolved = resolve(
				m.src.startsWith("~") ? join(homedir(), m.src.slice(1))
					: m.src.startsWith("/") ? m.src
					: join(cwd, m.src)
			);
			if (!existsSync(resolved)) return m;
			const filename = basename(resolved);
			toCopy.push({ src: resolved, dest: join(imagesDir, filename) });
			changed = true;
			return { ...m, src: "images/" + filename };
		});
		if (!changed) return q;
		return { ...q, media: Array.isArray(q.media) ? newMedia : newMedia[0] };
	});
	if (toCopy.length > 0) {
		await mkdir(imagesDir, { recursive: true });
		await Promise.all(toCopy.map(f => copyFile(f.src, f.dest)));
	}
	return rewritten;
}

function renderQuestionsHtml(
	questionsList: Question[],
	answers: ResponseItem[],
	optionInsights: SavedOptionInsight[],
): string {
	const answerMap = new Map(answers.map((a) => [a.id, a]));
	let questionNum = 0;
	return questionsList
		.map((q) => {
			const showNumber = q.type !== "info";
			if (showNumber) questionNum++;
			const numPrefix = showNumber ? `${questionNum}. ` : "";
			const mediaHtml = renderMediaListHtml(q.media);
			const optionInsightsHtml = renderSavedOptionInsightsHtml(
				optionInsights.filter((insight) => insight.questionId === q.id),
			);

			if (q.type === "info") {
				const contentHtml = renderContentBlockHtml(q.content);
				return `
      <div class="${weightClasses(q)}">
        <h2>${escapeHtml(q.question)}</h2>
        ${q.context ? `<p class="question-context">${escapeHtml(q.context)}</p>` : ""}
        ${contentHtml}
        ${mediaHtml}
        ${optionInsightsHtml}
      </div>
    `;
			}

			const ans = answerMap.get(q.id);
			const value = ans?.value;
			const attachments = ans?.attachments ?? [];

			let answerHtml: string;
			if (!value || (Array.isArray(value) && value.length === 0)) {
				answerHtml = '<div class="saved-answer empty">(no answer)</div>';
			} else if (q.type === "image") {
				const paths = Array.isArray(value) ? value : [value];
				answerHtml = `<div class="saved-images">${paths
					.map((p) => `<img src="${escapeHtml(p)}" alt="uploaded image">`)
					.join("")}</div>`;
			} else if (q.type === "multi") {
				const items = Array.isArray(value) ? value.filter(isChoiceResponseValue) : [];
				answerHtml = `<div class="saved-answer"><ul>${items
					.map((item) => `<li>${savedChoiceAnswerHtml(item, q)}</li>`)
					.join("")}</ul></div>`;
				if (items.length === 0) {
					answerHtml = '<div class="saved-answer empty">(no answer)</div>';
				}
			} else if (q.type === "single") {
				answerHtml = isChoiceResponseValue(value)
					? `<div class="saved-answer">${savedChoiceAnswerHtml(value, q)}</div>`
					: '<div class="saved-answer empty">(no answer)</div>';
			} else {
				answerHtml = `<div class="saved-answer">${savedAnswerItemHtml(String(value), q)}</div>`;
			}

			const contentHtml = renderContentBlockHtml(q.content);

			const attachHtml =
				attachments.length > 0
					? `<div class="saved-attachments">${attachments
							.map((p) => `<img src="${escapeHtml(p)}" alt="attachment">`)
							.join("")}</div>`
					: "";

			const contextHtml = q.context
				? `<p class="question-context">${escapeHtml(q.context)}</p>`
				: "";

			return `
      <div class="${weightClasses(q)}">
        <h2>${numPrefix}${escapeHtml(q.question)}</h2>
        ${contextHtml}
        ${contentHtml}
        ${mediaHtml}
        ${optionInsightsHtml}
        ${answerHtml}
        ${attachHtml}
      </div>
    `;
		})
		.join("\n");
}

const SAVED_VIEW_STYLES = `
.saved-interview {
  max-width: 680px;
  margin: 0 auto;
  padding: var(--spacing);
}
.saved-header {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-muted);
}
.saved-header h1 {
  margin: 0 0 8px;
  font-size: 20px;
}
.saved-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  color: var(--fg-muted);
}
.saved-status {
  padding: 2px 8px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
}
.saved-status.submitted {
  color: var(--success);
  border: 1px solid var(--success);
}
.saved-status.draft {
  color: var(--warning);
  border: 1px solid var(--warning);
}
.saved-question {
  margin-bottom: 20px;
  padding: 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius);
}
.saved-question h2 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 500;
}
.saved-code {
  margin: 12px 0;
  padding: 12px;
  background: var(--bg-body);
  border-radius: var(--radius);
  overflow-x: hidden;
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.saved-answer {
  color: var(--fg);
  padding: 8px 12px;
  background: var(--bg-body);
  border-radius: var(--radius);
  white-space: pre-wrap;
}
.saved-option-insights {
  display: grid;
  gap: 10px;
  margin: 14px 0;
}
.saved-option-insight {
  border: 1px solid var(--border-muted);
  border-radius: 12px;
  padding: 12px;
  background: color-mix(in srgb, var(--bg-body) 82%, transparent);
}
.saved-option-insight-prompt {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
  margin-bottom: 4px;
}
.saved-option-insight-meta {
  font-size: 11px;
  color: var(--fg-muted);
  margin-bottom: 8px;
}
.saved-option-insight p {
  margin: 0;
}
.saved-option-insight ul {
  margin: 8px 0 0;
  padding-left: 18px;
}
.saved-option-insight-suggestion {
  margin-top: 10px;
  display: grid;
  gap: 4px;
}
.saved-option-insight-suggestion span {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}
.saved-option-insight-suggestion code {
  display: block;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg-body);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.saved-answer.empty {
  color: var(--fg-dim);
  font-style: italic;
}
.saved-answer ul {
  margin: 0;
  padding-left: 20px;
}
.saved-answer-choice {
  display: grid;
  gap: 4px;
}
.saved-answer-note {
  color: var(--fg-muted);
  font-size: 12px;
}
.saved-images, .saved-attachments {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.saved-images img, .saved-attachments img {
  max-width: 200px;
  max-height: 150px;
  border-radius: var(--radius);
  border: 1px solid var(--border-muted);
}
.saved-question.info-panel h2 {
  color: var(--fg-muted);
}
.saved-question.weight-critical {
  border-left: 5px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 4%, var(--bg-elevated));
}
.saved-question.weight-minor {
  padding: 12px;
}
.saved-question.weight-minor h2 {
  font-size: 13px;
}
.recommended-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  margin-left: 6px;
  border-radius: 8px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}
`;

function generateSavedHtml(options: {
	questions: QuestionsFile;
	answers: ResponseItem[];
	optionInsights: SavedOptionInsight[];
	optionKeysByQuestion: Record<string, string[]>;
	meta: SavedInterviewMeta;
	baseStyles: string;
	themeCss: string;
}): string {
	const { questions: questionsData, answers, optionInsights, optionKeysByQuestion, meta, baseStyles, themeCss } = options;
	const title = questionsData.title || "Interview";

	// Build the data object for embedding
	const dataForEmbedding = {
		title: questionsData.title,
		description: questionsData.description,
		questions: questionsData.questions,
		savedAnswers: answers,
		savedOptionInsights: optionInsights,
		optionKeysByQuestion,
		savedAt: meta.savedAt,
		wasSubmitted: meta.wasSubmitted,
		savedFrom: meta.savedFrom,
	};

	const embeddedJson = safeInlineJSON(dataForEmbedding);
	const questionsHtml = renderQuestionsHtml(questionsData.questions, answers, optionInsights);
	const savedDate = new Date(meta.savedAt).toLocaleString();
	const statusClass = meta.wasSubmitted ? "submitted" : "draft";
	const statusText = meta.wasSubmitted ? "Submitted" : "Draft";

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Saved Interview</title>
  <style>
${baseStyles}
${themeCss}
${SAVED_VIEW_STYLES}
  </style>
</head>
<body>
  <main class="saved-interview">
    <header class="saved-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="saved-meta">
        <span>Saved: ${escapeHtml(savedDate)}</span>
        <span>Project: ${escapeHtml(meta.savedFrom.cwd)}</span>
        ${meta.savedFrom.branch ? `<span>Branch: ${escapeHtml(meta.savedFrom.branch)}</span>` : ""}
        <span class="saved-status ${statusClass}">${statusText}</span>
      </div>
    </header>
    <div class="saved-questions">
${questionsHtml}
    </div>
  </main>
  <script type="application/json" id="pi-interview-data">
${embeddedJson}
  </script>
</body>
</html>`;
}

export async function startInterviewServer(
	options: InterviewServerOptions,
	callbacks: InterviewServerCallbacks
): Promise<InterviewServerHandle> {
	const { questions, sessionToken, sessionId, cwd, timeout, port, verbose } = options;
	const questionById = new Map<string, Question>();
	for (const question of questions.questions) {
		questionById.set(question.id, question);
	}
	const optionKeysByQuestion = buildOptionKeysByQuestion(questions.questions, options.optionKeysByQuestion);
	const initialSavedOptionInsights = normalizeSavedOptionInsights(options.savedOptionInsights);

	function getMediaList(q: Question): MediaBlock[] {
		if (!q.media) return [];
		return Array.isArray(q.media) ? q.media : [q.media];
	}

	const needsChartJs = questions.questions.some(q =>
		getMediaList(q).some(m => m.type === "chart")
	);
	const needsMermaid = questions.questions.some(q =>
		getMediaList(q).some(m => m.type === "mermaid")
	);

	let cdnScripts = "";
	if (needsChartJs) {
		cdnScripts += '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>\n';
	}
	if (needsMermaid) {
		cdnScripts += '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n';
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

	const normalizedCwd = normalizePath(cwd);
	const gitBranch = getGitBranch(cwd);
	let sessionEntry: SessionEntry | null = null;
	let browserConnected = false;
	let lastHeartbeatAt = Date.now();
	let watchdog: NodeJS.Timeout | null = null;
	let sessionKeepAlive: NodeJS.Timeout | null = null;
	let completed = false;

	const stopWatchdog = () => {
		if (watchdog) {
			clearInterval(watchdog);
			watchdog = null;
		}
	};

	const stopSessionKeepAlive = () => {
		if (sessionKeepAlive) {
			clearInterval(sessionKeepAlive);
			sessionKeepAlive = null;
		}
	};

	const markCompleted = () => {
		if (completed) return false;
		completed = true;
		stopWatchdog();
		stopSessionKeepAlive();
		return true;
	};

	const touchHeartbeat = () => {
		lastHeartbeatAt = Date.now();
		if (!browserConnected) {
			browserConnected = true;
		}
		if (sessionEntry) {
			touchSession(sessionEntry);
		}
	};

	const server = http.createServer(async (req, res) => {
		try {
			const method = req.method || "GET";
			const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
			log(verbose, `${method} ${url.pathname}`);

			const parseBodyOrRespond = async (): Promise<unknown | null> => {
				try {
					return await parseJSONBody(req);
				} catch (err) {
					if (err instanceof BodyTooLargeError) {
						sendJson(res, err.statusCode, { ok: false, error: err.message });
						return null;
					}
					const message = err instanceof Error ? err.message : String(err);
					sendJson(res, 400, { ok: false, error: message });
					return null;
				}
			};

			if (method === "GET" && url.pathname === "/") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				touchHeartbeat();
				const inlineData = safeInlineJSON({
					questions: questions.questions,
					title: questions.title,
					description: questions.description,
					sessionToken,
					sessionId,
					cwd: normalizedCwd,
					gitBranch,
					startedAt: Date.now(),
					timeout,
					theme: {
						mode: themeMode,
						toggleHotkey: themeConfig.toggleHotkey,
					},
					savedAnswers: options.savedAnswers,
					savedOptionInsights: initialSavedOptionInsights,
					optionKeysByQuestion,
					autoSaveOnSubmit: options.autoSaveOnSubmit ?? true,
					canGenerate: options.canGenerate ?? false,
					askModels: options.askModels ?? [],
					defaultAskModel: options.defaultAskModel ?? null,
				});
				const html = TEMPLATE
					.replace("<!-- __CDN_SCRIPTS__ -->", cdnScripts)
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

			if (method === "GET" && url.pathname === "/sessions") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				const sessions = listSessions().map((session) => ({
					...session,
					status: Date.now() - session.lastSeen < STALE_THRESHOLD_MS ? "active" : "waiting",
				}));
				sendJson(res, 200, { ok: true, sessions });
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

			if (method === "GET" && url.pathname === "/media") {
				if (!validateTokenQuery(url, sessionToken, res)) return;
				const filePath = url.searchParams.get("path");
				if (!filePath) {
					sendText(res, 400, "Missing path parameter");
					return;
				}

				const home = homedir();
				const resolved = resolve(
					filePath.startsWith("~")
						? join(home, filePath.slice(1))
						: filePath.startsWith("/")
							? filePath
							: join(cwd, filePath)
				);

				const allowed = [cwd, home, tmpdir()];
				const isAllowed = allowed.some(dir => resolved === dir || resolved.startsWith(dir + "/"));
				if (!isAllowed) {
					sendText(res, 403, "Path not allowed");
					return;
				}

				if (!existsSync(resolved)) {
					sendText(res, 404, "File not found");
					return;
				}

				const ext = resolved.split(".").pop()?.toLowerCase();
				const mimeTypes: Record<string, string> = {
					png: "image/png",
					jpg: "image/jpeg",
					jpeg: "image/jpeg",
					gif: "image/gif",
					webp: "image/webp",
					svg: "image/svg+xml",
				};

				const contentType = mimeTypes[ext || ""] || "application/octet-stream";
				const data = readFileSync(resolved);
				res.writeHead(200, {
					"Content-Type": contentType,
					"Cache-Control": "private, max-age=300",
					"Content-Length": data.length,
				});
				res.end(data);
				return;
			}

			if (method === "POST" && url.pathname === "/heartbeat") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				touchHeartbeat();
				sendJson(res, 200, { ok: true });
				return;
			}

			if (method === "POST" && url.pathname === "/cancel") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				if (completed) {
					sendJson(res, 200, { ok: true });
					return;
				}
				const payload = body as { reason?: string; responses?: ResponseItem[] };
				const reason = payload.reason;
				if (reason === "timeout" || reason === "stale") {
					const recoveryPath = saveToRecovery(questions, cwd, gitBranch, sessionId);
					const label = reason === "timeout" ? "timed out" : "stale";
					log(verbose, `Interview ${label}. Saved to: ${recoveryPath}`);
				}
				markCompleted();
				unregisterSession(sessionId);
				sendJson(res, 200, { ok: true });
				const partialResponses = Array.isArray(payload.responses) ? payload.responses : undefined;
				setImmediate(() => callbacks.onCancel(reason as "timeout" | "user" | "stale" | undefined, partialResponses));
				return;
			}

			if (method === "POST" && url.pathname === "/submit") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				if (completed) {
					sendJson(res, 409, { ok: false, error: "Session closed" });
					return;
				}

				const payload = body as {
					responses?: unknown[];
					images?: Array<{ id: string; filename: string; mimeType: string; data: string; isAttachment?: boolean }>;
				};

				const responsesInput = Array.isArray(payload.responses) ? payload.responses : [];
				const imagesInput = Array.isArray(payload.images) ? payload.images : [];

				if (imagesInput.length > MAX_IMAGES) {
					sendJson(res, 400, { ok: false, error: `Too many images (max ${MAX_IMAGES})` });
					return;
				}

				const normalizedResponses = normalizeResponseItems(responsesInput, questionById);
				if (normalizedResponses.ok === false) {
					sendJson(res, 400, {
						ok: false,
						error: normalizedResponses.error,
						field: normalizedResponses.field,
					});
					return;
				}
				const responses = normalizedResponses.responses;

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

				markCompleted();
				unregisterSession(sessionId);
				const nextSession = getActiveSessions()
					.filter((s) => s.id !== sessionId)
					.sort((a, b) => {
						if (a.startedAt !== b.startedAt) {
							return a.startedAt - b.startedAt;
						}
						return a.id.localeCompare(b.id);
					})[0];
				const nextUrl = nextSession ? nextSession.url : null;
				sendJson(res, 200, { ok: true, nextUrl });
				setImmediate(() => callbacks.onSubmit(responses));
				return;
			}

			if (method === "POST" && url.pathname === "/save") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				// Note: don't check `completed` - allow save after submit

				const payload = body as {
					responses?: unknown[];
					savedOptionInsights?: SavedOptionInsight[];
					images?: Array<{
						id: string;
						filename: string;
						mimeType: string;
						data: string;
						isAttachment?: boolean;
					}>;
					submitted?: boolean;
				};

				const responsesInput = Array.isArray(payload.responses) ? payload.responses : [];
				const savedOptionInsights = normalizeSavedOptionInsights(payload.savedOptionInsights);
				const imagesInput = Array.isArray(payload.images) ? payload.images : [];
				const submitted = payload.submitted === true;
				const normalizedResponses = normalizeResponseItems(responsesInput, questionById);
				if (normalizedResponses.ok === false) {
					sendJson(res, 400, {
						ok: false,
						error: normalizedResponses.error,
						field: normalizedResponses.field,
					});
					return;
				}

				const snapshotBaseDir = options.snapshotDir ?? SNAPSHOTS_DIR;

				// Build folder name: {title}-{project}-{branch}-{timestamp}[-submitted]
				const now = new Date();
				const date = now.toISOString().slice(0, 10);
				const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
				const timestamp = `${date}-${time}`;
				const project = sanitizeForFilename(basename(cwd) || "unknown");
				const branch = sanitizeForFilename(gitBranch || "nogit");
				const titleSlug = sanitizeForFilename(questions.title || "interview");
				const suffix = submitted ? "-submitted" : "";
				const folderName = `${titleSlug}-${project}-${branch}-${timestamp}${suffix}`;
				const snapshotPath = join(snapshotBaseDir, folderName);
				const imagesPath = join(snapshotPath, "images");

				await mkdir(snapshotPath, { recursive: true });

				// Process responses - make a deep copy to avoid mutating input
				const savedResponses: ResponseItem[] = normalizedResponses.responses.map((response) => ({
					...response,
					value: cloneResponseValue(response.value),
					attachments: response.attachments ? [...response.attachments] : undefined,
				}));

				// Process uploaded images - save to images/ subfolder
				if (imagesInput.length > 0) {
					await mkdir(imagesPath, { recursive: true });
					for (const image of imagesInput) {
						if (!image || typeof image.id !== "string") continue;

						try {
							const absPath = await handleImageUpload(image, sessionId, imagesPath);
							const relPath = "images/" + basename(absPath);

							const existing = savedResponses.find((r) => r.id === image.id);
							if (image.isAttachment) {
								if (existing) {
									existing.attachments = existing.attachments || [];
									existing.attachments.push(relPath);
								} else {
									savedResponses.push({ id: image.id, value: "", attachments: [relPath] });
								}
							} else {
								if (existing) {
									if (Array.isArray(existing.value)) {
										existing.value.push(relPath);
									} else if (existing.value === "") {
										existing.value = relPath;
									} else {
										existing.value = [existing.value, relPath];
									}
								} else {
									savedResponses.push({ id: image.id, value: relPath });
								}
							}
						} catch (err) {
							const message = err instanceof Error ? err.message : "Image upload failed";
							sendJson(res, 400, { ok: false, error: message, field: image.id });
							return;
						}
					}
				}

				// Copy local media images to snapshot and rewrite paths
				const rewrittenQuestions = await copyMediaImages(questions.questions, imagesPath, cwd);
				const snapshotQuestions: QuestionsFile = {
					...questions,
					questions: rewrittenQuestions,
				};

				// Generate HTML with embedded data
				const meta: SavedInterviewMeta = {
					savedAt: new Date().toISOString(),
					wasSubmitted: submitted,
					savedFrom: { cwd: normalizedCwd, branch: gitBranch, sessionId },
				};
				const themeCss = themeMode === "light" ? themeLightCss : themeDarkCss;
				const html = generateSavedHtml({
					questions: snapshotQuestions,
					answers: savedResponses,
					optionInsights: savedOptionInsights,
					optionKeysByQuestion,
					meta,
					baseStyles: STYLES,
					themeCss,
				});

				await writeFile(join(snapshotPath, "index.html"), html);

				sendJson(res, 200, {
					ok: true,
					path: snapshotPath,
					relativePath: normalizePath(snapshotPath),
				});
				return;
			}

			if (method === "POST" && url.pathname === "/generate") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				if (completed) {
					sendJson(res, 409, { ok: false, error: "Session closed" });
					return;
				}

				if (!callbacks.onGenerate) {
					sendJson(res, 501, { ok: false, error: "Generation not available" });
					return;
				}

				const payload = body as {
					questionId?: string;
					mode?: string;
				};

				if (typeof payload.questionId !== "string") {
					sendJson(res, 400, { ok: false, error: "Missing questionId" });
					return;
				}

				const question = questionById.get(payload.questionId);
				if (!question || (question.type !== "single" && question.type !== "multi")) {
					sendJson(res, 400, { ok: false, error: "Invalid question for generation" });
					return;
				}

				const existingOptions = question.options.map((option) => getOptionLabel(option).trim());

				const mode = payload.mode === "review" ? "review" : "add";

				const controller = new AbortController();
				res.on("close", () => {
					if (!res.writableEnded) controller.abort();
				});
				touchHeartbeat();

				try {
					const result = await callbacks.onGenerate(
						payload.questionId,
						existingOptions,
						controller.signal,
						mode,
					);

					const uniqueOptions = normalizeGeneratedOptionValues(result.options);

					const reviewedQuestion = typeof result.question === "string" ? result.question.trim() : undefined;
					const storedQuestion = questions.questions.find((q) => q.id === payload.questionId);
					let nextOptionKeys = optionKeysByQuestion[payload.questionId] ?? [];
					let appliedOptions: OptionValue[] = [];
					if (storedQuestion) {
						if (mode === "review" && reviewedQuestion && uniqueOptions.length > 0) {
							const previousOptions = [...storedQuestion.options];
							const previousKeys = [...(optionKeysByQuestion[payload.questionId] ?? [])];
							storedQuestion.question = reviewedQuestion;
							storedQuestion.options = uniqueOptions;
							syncRecommendations(storedQuestion, uniqueOptions);
							nextOptionKeys = reconcileOptionKeysByLabel(previousOptions, previousKeys, uniqueOptions);
							optionKeysByQuestion[payload.questionId] = nextOptionKeys;
							appliedOptions = uniqueOptions;
						} else if (mode === "add") {
							const existingKeys = new Set(storedQuestion.options.map((option) => getOptionLabel(option).trim().toLowerCase()));
							const newOptions = uniqueOptions.filter((option) => !existingKeys.has(getOptionLabel(option).trim().toLowerCase()));
							if (newOptions.length > 0) {
								storedQuestion.options = storedQuestion.options.concat(newOptions);
								nextOptionKeys = (optionKeysByQuestion[payload.questionId] ?? []).concat(newOptions.map(() => makeOptionKey()));
								optionKeysByQuestion[payload.questionId] = nextOptionKeys;
							}
							appliedOptions = newOptions;
						}
					}

					sendJson(res, 200, {
						ok: true,
						options: appliedOptions,
						question: reviewedQuestion,
						optionKeys: nextOptionKeys,
					});
				} catch (err) {
					if (controller.signal.aborted) {
						sendJson(res, 409, { ok: false, error: "Request cancelled" });
						return;
					}
					const message = err instanceof Error ? err.message : "Generation failed";
					sendJson(res, 500, { ok: false, error: message });
				}
				return;
			}

			if (method === "POST" && url.pathname === "/option-insight") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				if (completed) {
					sendJson(res, 409, { ok: false, error: "Session closed" });
					return;
				}

				if (!callbacks.onOptionInsight) {
					sendJson(res, 501, { ok: false, error: "Option insight not available" });
					return;
				}

				const payload = body as {
					questionId?: string;
					optionKey?: string;
					prompt?: string;
					model?: string | null;
				};

				if (typeof payload.questionId !== "string") {
					sendJson(res, 400, { ok: false, error: "Missing questionId" });
					return;
				}
				if (typeof payload.optionKey !== "string") {
					sendJson(res, 400, { ok: false, error: "Missing optionKey" });
					return;
				}
				if (typeof payload.prompt !== "string" || payload.prompt.trim().length === 0) {
					sendJson(res, 400, { ok: false, error: "Prompt is required" });
					return;
				}

				const questionCheck = ensureQuestionId(payload.questionId, questionById);
				if (questionCheck.ok === false) {
					sendJson(res, 400, { ok: false, error: questionCheck.error });
					return;
				}
				const question = questionCheck.question;
				const optionIndex = getOptionIndexByKey(question, optionKeysByQuestion, payload.optionKey);
				if (optionIndex === -1 || !question.options || optionIndex >= question.options.length) {
					sendJson(res, 400, { ok: false, error: "Invalid option for insight" });
					return;
				}

				const controller = new AbortController();
				res.on("close", () => {
					if (!res.writableEnded) controller.abort();
				});
				touchHeartbeat();

				try {
					const option = question.options[optionIndex];
					const optionText = getOptionLabel(option);
					const result = await callbacks.onOptionInsight(
						payload.questionId,
						option,
						payload.prompt.trim(),
						typeof payload.model === "string" ? payload.model : null,
						controller.signal,
					);
					sendJson(res, 200, { ok: true, optionText, ...result });
				} catch (err) {
					if (controller.signal.aborted) {
						sendJson(res, 409, { ok: false, error: "Request cancelled" });
						return;
					}
					const message = err instanceof Error ? err.message : "Option insight failed";
					sendJson(res, 500, { ok: false, error: message });
				}
				return;
			}

			if (method === "POST" && url.pathname === "/option-action") {
				const body = await parseBodyOrRespond();
				if (!body) return;
				if (!validateTokenBody(body, sessionToken, res)) return;
				if (completed) {
					sendJson(res, 409, { ok: false, error: "Session closed" });
					return;
				}

				const payload = body as {
					questionId?: string;
					optionKey?: string;
					action?: string;
					text?: string;
				};

				if (typeof payload.questionId !== "string") {
					sendJson(res, 400, { ok: false, error: "Missing questionId" });
					return;
				}
				if (typeof payload.optionKey !== "string") {
					sendJson(res, 400, { ok: false, error: "Missing optionKey" });
					return;
				}
				touchHeartbeat();

				const questionCheck = ensureQuestionId(payload.questionId, questionById);
				if (questionCheck.ok === false) {
					sendJson(res, 400, { ok: false, error: questionCheck.error });
					return;
				}
				const question = questionCheck.question;
				if ((question.type !== "single" && question.type !== "multi") || !question.options) {
					sendJson(res, 400, { ok: false, error: "Invalid question for option actions" });
					return;
				}

				const optionIndex = getOptionIndexByKey(question, optionKeysByQuestion, payload.optionKey);
				if (optionIndex === -1) {
					sendJson(res, 400, { ok: false, error: "Invalid option for action" });
					return;
				}

				const currentOptions = [...question.options];
				const currentKeys = [...(optionKeysByQuestion[question.id] ?? [])];
				const action = payload.action;
				const rawText = typeof payload.text === "string" ? payload.text.trim() : "";

				if (action === "move-up") {
					if (optionIndex === 0) {
						sendJson(res, 400, { ok: false, error: "Option is already at the top" });
						return;
					}
					[currentOptions[optionIndex - 1], currentOptions[optionIndex]] = [currentOptions[optionIndex], currentOptions[optionIndex - 1]];
					[currentKeys[optionIndex - 1], currentKeys[optionIndex]] = [currentKeys[optionIndex], currentKeys[optionIndex - 1]];
				} else if (action === "replace-text") {
					if (!rawText) {
						sendJson(res, 400, { ok: false, error: "Replacement text is required" });
						return;
					}
					const duplicateIndex = currentOptions.findIndex((option, index) => index !== optionIndex && getOptionLabel(option).trim().toLowerCase() === rawText.toLowerCase());
					if (duplicateIndex !== -1) {
						sendJson(res, 400, { ok: false, error: "An option with that text already exists" });
						return;
					}
					const previousText = getOptionLabel(currentOptions[optionIndex]);
					currentOptions[optionIndex] = setOptionLabel(currentOptions[optionIndex], rawText);
					if (question.type === "single" && question.recommended === previousText) {
						question.recommended = rawText;
					} else if (question.type === "multi" && Array.isArray(question.recommended)) {
						question.recommended = question.recommended.map((option) => option === previousText ? rawText : option);
					}
				} else if (action === "add-option") {
					if (!rawText) {
						sendJson(res, 400, { ok: false, error: "New option text is required" });
						return;
					}
					if (currentOptions.some((option) => getOptionLabel(option).trim().toLowerCase() === rawText.toLowerCase())) {
						sendJson(res, 400, { ok: false, error: "An option with that text already exists" });
						return;
					}
					const newOptionKey = makeOptionKey();
					currentOptions.splice(optionIndex + 1, 0, rawText);
					currentKeys.splice(optionIndex + 1, 0, newOptionKey);
				} else {
					sendJson(res, 400, { ok: false, error: "Unsupported option action" });
					return;
				}

				question.options = currentOptions;
				optionKeysByQuestion[question.id] = currentKeys;
				syncRecommendations(question, currentOptions);

				sendJson(res, 200, {
					ok: true,
					question,
					optionKeys: currentKeys,
				});
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
		server.listen(port ?? 0, "127.0.0.1", () => {
			server.off("error", onError);
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to start server: invalid address"));
				return;
			}
			const url = `http://localhost:${addr.port}/?session=${sessionToken}`;
			cleanupOldRecoveryFiles();
			const now = Date.now();
			sessionEntry = {
				id: sessionId,
				url,
				cwd: normalizedCwd,
				gitBranch,
				title: questions.title || "Interview",
				startedAt: now,
				lastSeen: now,
			};
			registerSession(sessionEntry);
			const keepAliveEntry = sessionEntry;
			sessionKeepAlive = setInterval(() => {
				if (completed) return;
				touchSession(keepAliveEntry);
			}, 10000);
			if (!watchdog) {
				watchdog = setInterval(() => {
					if (completed || !browserConnected) return;
					if (Date.now() - lastHeartbeatAt <= ABANDONED_GRACE_MS) return;
					if (!markCompleted()) return;
					const recoveryPath = saveToRecovery(questions, cwd, gitBranch, sessionId);
					log(verbose, `Interview stale. Saved to: ${recoveryPath}`);
					unregisterSession(sessionId);
					setImmediate(() => callbacks.onCancel("stale"));
				}, WATCHDOG_INTERVAL_MS);
			}
			resolve({
				server,
				url,
				close: () => {
					try {
						markCompleted();
						unregisterSession(sessionId);
						server.close();
					} catch {}
				},
			});
		});
	});
}
