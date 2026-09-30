import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function interviewTestContext(cwd: string): ExtensionContext {
	const registry: Pick<ExtensionContext["modelRegistry"], "getAvailable"> = { getAvailable: () => [] };
	const ui: Pick<ExtensionContext["ui"], "notify"> = { notify: () => {} };
	const context: Partial<ExtensionContext> = {
		cwd,
		hasUI: true,
		hasPendingMessages: () => false,
		model: undefined,
		// SAFETY: With no models configured, the interview only calls getAvailable on the registry.
		modelRegistry: registry as ExtensionContext["modelRegistry"],
		// SAFETY: Browser-based interviews only use notify from the Pi UI.
		ui: ui as ExtensionContext["ui"],
	};
	// SAFETY: The interview reads only these context fields in this test.
	return context as ExtensionContext;
}
