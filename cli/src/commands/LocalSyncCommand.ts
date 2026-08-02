/**
 * `jolli local-sync` — manually drive one Local Sync round from the
 * terminal, and the only way to resolve an unresolved conflict.
 *
 * Local Sync's automatic triggers (in-process push from `QueueWorker.ts`,
 * detached pull from `SessionStartHook.ts` via `LocalSyncWorker.ts`) cover
 * normal operation — this command exists for:
 *   - forcing a round before switching machines, without waiting for the
 *     next commit or session start
 *   - debugging a sync issue from the terminal
 *   - resolving an unresolved conflict via `--force-push-mine` /
 *     `--force-take-theirs` — the ONLY code path that ever discards data,
 *     both requiring an explicit flag (mirrors `jolli sync-memory-bank`'s
 *     rationale for why the CLI can't meaningfully prompt for a binary pick:
 *     no diff viewer, no live conflicts panel).
 */

import type { Command } from "commander";
import { createLogger, setLogDir } from "../Logger.js";
import { runLocalSyncRound } from "../localsync/LocalSyncEngine.js";
import type { LocalSyncResult } from "../localsync/LocalSyncTypes.js";
import { resolveProjectDir } from "./CliUtils.js";

const log = createLogger("local-sync");

interface LocalSyncCommandOptions {
	readonly cwd: string;
	readonly forcePushMine?: boolean;
	readonly forceTakeTheirs?: boolean;
}

export async function runLocalSync(options: LocalSyncCommandOptions): Promise<number> {
	if (options.forcePushMine && options.forceTakeTheirs) {
		console.error("\n  Error: pass only one of --force-push-mine / --force-take-theirs.\n");
		return 1;
	}
	const force = options.forcePushMine ? "mine" : options.forceTakeTheirs ? "theirs" : undefined;

	console.log("\n  Running Local Sync…");
	const result = await runLocalSyncRound(options.cwd, { force });
	return reportResult(result);
}

function reportResult(result: LocalSyncResult): number {
	switch (result.outcome) {
		case "not-configured":
			console.error(
				"\n  Local Sync is not configured. Set localSyncEnabled, localSyncRepoUrl, and localSyncToken:\n" +
					"    jolli configure --set localSyncEnabled=true --set localSyncRepoUrl=<https-url> --set localSyncToken=<pat>\n",
			);
			return 1;
		case "disabled":
			console.log("\n  Local Sync skipped — this repository is manually disabled.\n");
			return 0;
		case "up-to-date":
			console.log(`\n  Already up to date.${result.message ? ` (${result.message})` : ""}\n`);
			return 0;
		case "pushed":
			console.log(`\n  Pushed to ${result.destBranch}.\n`);
			return 0;
		case "pulled":
			console.log(`\n  Pulled from ${result.destBranch} — local Memory Bank updated.\n`);
			return 0;
		case "merged":
			console.log(`\n  Merged divergent history on ${result.destBranch} (not yet pushed — local only).\n`);
			return 0;
		case "conflict-unresolved":
			console.error(
				`\n  Unresolved: ${result.message ?? "conflict"}\n` +
					"  Re-run with --force-push-mine (keep local) or --force-take-theirs (adopt remote) to resolve.\n",
			);
			return 1;
		case "offline":
			console.error(
				`\n  Offline — could not reach the Local Sync destination.${result.message ? ` ${result.message}` : ""}\n`,
			);
			return 1;
		case "error":
			console.error(
				`\n  Local Sync failed${result.errorCode ? ` (${result.errorCode})` : ""}: ${result.message ?? "unknown error"}\n`,
			);
			return 1;
		/* v8 ignore next 2 -- exhaustive switch; no default arm needed for a closed union */
	}
}

/** Registers the `local-sync` sub-command on the given Commander program. */
export function registerLocalSyncCommand(program: Command): void {
	program
		.command("local-sync")
		.description("Sync this repo's Memory Bank orphan branch with your self-hosted Local Sync repo")
		.option("--cwd <dir>", "Project directory (default: git repo root)", resolveProjectDir())
		.option("--force-push-mine", "On unresolved conflict, discard the remote side and push local state")
		.option("--force-take-theirs", "On unresolved conflict, discard local state and adopt the remote side")
		.action(async (options: { cwd: string; forcePushMine?: boolean; forceTakeTheirs?: boolean }) => {
			setLogDir(options.cwd);
			log.info("Running 'local-sync' command");
			const exit = await runLocalSync(options);
			if (exit !== 0) process.exitCode = exit;
		});
}
