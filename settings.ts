import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

export interface InterviewThemeSettings {
	mode?: "auto" | "light" | "dark";
	name?: string;
	lightPath?: string;
	darkPath?: string;
	toggleHotkey?: string;
}

export interface InterviewSettings {
	browser?: string;
	launcher?: "glimpse" | "browser" | "orca";
	timeout?: number;
	port?: number;
	theme?: InterviewThemeSettings;
	snapshotDir?: string;      // Default: ~/.pi/interview-snapshots/
	autoSaveOnSubmit?: boolean; // Default: true
	generateModel?: string;    // e.g., "anthropic/claude-haiku-4-5"
	glimpseFloating?: boolean; // Default: false
}

export const LAUNCHERS = ["glimpse", "browser", "orca"] as const;

// launcher selects behavior, so an unrecognized value must fail loudly instead of
// silently reverting to the automatic Glimpse-or-browser path.
export function assertValidLauncher(value: unknown): void {
	if (value === undefined) return;
	if (typeof value === "string" && (LAUNCHERS as readonly string[]).includes(value)) return;
	throw new Error(
		`interview.launcher must be one of: ${LAUNCHERS.join(", ")} (received ${JSON.stringify(value)})`,
	);
}

export function loadSettings(settingsPath: string = SETTINGS_PATH): InterviewSettings {
	if (!existsSync(settingsPath)) {
		return {};
	}

	const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
	if (typeof parsed !== "object" || parsed === null) {
		return {};
	}

	const interview = (parsed as Record<string, unknown>).interview;
	if (typeof interview !== "object" || interview === null) {
		return {};
	}

	assertValidLauncher((interview as Record<string, unknown>).launcher);
	return interview as InterviewSettings;
}
