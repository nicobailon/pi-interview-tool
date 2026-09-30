import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const OrcaTabs = Type.Object({
	result: Type.Object({
		tabs: Type.Array(Type.Object({
			url: Type.String(),
			browserPageId: Type.String(),
			worktreeId: Type.String(),
		})),
	}),
});

export async function closeOrcaInterview(
	pi: Pick<ExtensionAPI, "exec">,
	url: string,
	cwd: string,
): Promise<void> {
	const exec = async (args: string[]): Promise<string> => {
		const result = await pi.exec("orca", args, { cwd });
		if (result.code !== 0 || result.killed) {
			throw new Error(`orca ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout || result.code}`);
		}
		return result.stdout;
	};

	// A queued interview can finish in a tab opened from another worktree.
	const output: unknown = JSON.parse(await exec(["tab", "list", "--worktree", "all", "--json"]));
	Value.Assert(OrcaTabs, output);
	for (const tab of output.result.tabs) {
		if (tab.url === url) {
			await exec(["tab", "close", "--page", tab.browserPageId, "--worktree", `id:${tab.worktreeId}`]);
		}
	}
}
