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
	timeout?: number;
	port?: number;
	theme?: InterviewThemeSettings;
	snapshotDir?: string;      // Default: ~/.pi/interview-snapshots/
	autoSaveOnSubmit?: boolean; // Default: true
	generateModel?: string;    // e.g., "anthropic/claude-haiku-4-5"
	glimpseFloating?: boolean; // Default: false
}

export function loadSettings(): InterviewSettings {
	if (!existsSync(SETTINGS_PATH)) {
		return {};
	}

	const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
	if (typeof parsed !== "object" || parsed === null) {
		return {};
	}

	const interview = (parsed as Record<string, unknown>).interview;
	if (typeof interview !== "object" || interview === null) {
		return {};
	}

	return interview as InterviewSettings;
}
