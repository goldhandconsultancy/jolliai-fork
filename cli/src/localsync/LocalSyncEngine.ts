/**
 * Local Sync — the orchestrator. One public entry point, `runLocalSyncRound`,
 * called from three places:
 *
 *   - `cli/src/hooks/QueueWorker.ts`, in-process via `setImmediate`, right
 *     after a drain writes new summaries to the orphan branch (the push side).
 *   - `cli/src/localsync/LocalSyncWorker.ts`, a detached background process
 *     spawned from `SessionStartHook.ts` with `{ pullOnly: true }` (the pull
 *     side — `SessionStartHook` has a hard 500ms budget and cannot await a
 *     network fetch inline).
 *   - `cli/src/commands/LocalSyncCommand.ts` (`jolli local-sync`), the manual
 *     fallback / force-resolve command.
 *
 * Every call is safe to make unconditionally, even when the feature is off or
 * unconfigured — the early checks make that a cheap no-op — and every
 * outcome is a returned {@link LocalSyncResult}, never a thrown exception, so
 * callers can log-and-ignore without a try/catch of their own.
 */

import {
	batchReadFilesFromBranch,
	execGit,
	fetchRefspec,
	isAncestor,
	listFilesInBranch,
	lsRemote,
	pushRefspec,
	readFileFromBranch,
	writeMergeCommitToBranch,
} from "../core/GitOps.js";
import { acquireOrphanWriteLock, releaseOrphanWriteLock } from "../core/Locks.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { loadConfig } from "../core/SessionTracker.js";
import { createLogger, ORPHAN_BRANCH } from "../Logger.js";
import { prepareAskpass } from "../sync/GitAskpass.js";
import type { FileWrite, SummaryIndex } from "../Types.js";
import { mergeSummaryIndex } from "./IndexMerge.js";
import { computeDestinationBranchName } from "./LocalSyncBranchName.js";
import { saveLocalSyncState, writeLocalSyncConflict } from "./LocalSyncStateStore.js";
import type { LocalSyncErrorCode, LocalSyncOutcome, LocalSyncResult } from "./LocalSyncTypes.js";

const log = createLogger("LocalSyncEngine");

/** Private fetch destination — never `refs/heads/*` or `refs/remotes/*`, so it never shows up in `git branch` and needs no `git remote add`. */
const REMOTE_TIP_REF = "refs/jolli-local-sync/remote-tip";

export interface RunLocalSyncRoundOpts {
	/** SessionStart-triggered rounds never push — only fetch + fast-forward the local ref when the remote is ahead. */
	readonly pullOnly?: boolean;
	/**
	 * Resolves an unresolved content conflict on this round by discarding one
	 * side. Only consulted when this round's own divergence check finds a
	 * genuine conflict — it does not replay a conflict recorded by an earlier
	 * round. The CLI's `--force-push-mine` / `--force-take-theirs` flags are
	 * the only way this is ever set.
	 */
	readonly force?: "mine" | "theirs";
}

async function saveState(
	cwd: string,
	outcome: LocalSyncOutcome,
	destBranch: string | undefined,
	localTip?: string,
	remoteTip?: string,
): Promise<void> {
	await saveLocalSyncState(cwd, {
		lastOutcome: outcome,
		...(destBranch !== undefined && { destBranch }),
		...(localTip !== undefined && { lastLocalTip: localTip }),
		...(remoteTip !== undefined && { lastRemoteTip: remoteTip }),
	});
}

/**
 * Classifies a failed git command's stderr into a {@link LocalSyncErrorCode}.
 * Returns `undefined` for a stderr that doesn't match any known pattern —
 * callers fall back to a generic `"error"` outcome with the raw message.
 */
function classifyGitError(stderr: string): LocalSyncErrorCode | undefined {
	const s = stderr.toLowerCase();
	if (/repository not found/.test(s)) return "repo-not-found";
	if (/authentication failed|permission denied|403/.test(s)) return "auth";
	if (
		/could not resolve host|network is unreachable|connection timed out|could not connect|etimedout|enotfound|econnrefused/.test(
			s,
		)
	) {
		return "network";
	}
	if (/\[rejected\]|non-fast-forward|fetch first/.test(s)) return "push-rejected";
	return undefined;
}

async function getRevOrNull(ref: string, cwd: string): Promise<string | null> {
	const result = await execGit(["rev-parse", ref], cwd);
	if (result.exitCode !== 0) return null;
	const hash = result.stdout.trim();
	return hash || null;
}

async function readIndex(ref: string, cwd: string): Promise<SummaryIndex> {
	const raw = await readFileFromBranch(ref, "index.json", cwd);
	if (!raw) return { version: 1, entries: [] };
	try {
		return JSON.parse(raw) as SummaryIndex;
	} catch {
		log.warn("index.json on %s failed to parse — treating as empty", ref);
		return { version: 1, entries: [] };
	}
}

async function pushOrphanTip(
	destUrl: string,
	destBranch: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<LocalSyncResult> {
	const localTip = await getRevOrNull(`refs/heads/${ORPHAN_BRANCH}`, cwd);
	const result = await pushRefspec(destUrl, `refs/heads/${ORPHAN_BRANCH}:refs/heads/${destBranch}`, cwd, env);
	if (result.exitCode !== 0) {
		const errorCode = classifyGitError(result.stderr) ?? "push-rejected";
		log.warn("Local Sync push rejected for %s: %s", destBranch, result.stderr);
		await saveState(cwd, "conflict-unresolved", destBranch, localTip ?? undefined);
		return {
			outcome: "conflict-unresolved",
			errorCode,
			destBranch,
			...(localTip && { localTip }),
			message: result.stderr,
		};
	}
	await saveState(cwd, "pushed", destBranch, localTip ?? undefined);
	return { outcome: "pushed", destBranch, ...(localTip && { localTip }) };
}

/**
 * Resolves a genuine divergence (neither side is an ancestor of the other):
 * merges `index.json` (the only aggregate file on the orphan branch — every
 * other path is content-addressed by commit hash and therefore either
 * identical on both sides or unique to one), unions any blobs unique to the
 * remote side, and writes a real two-parent merge commit before pushing.
 *
 * Aborts with NO writes (local or remote) the moment a shared non-index path
 * differs in content between the two sides, unless `opts.force` says which
 * side wins — per the content-addressing invariant this should never
 * actually happen; if it does, that indicates a bug rather than a normal
 * conflict, so the safe default is to stop rather than guess.
 */
async function resolveDivergence(
	cwd: string,
	destUrl: string,
	destBranch: string,
	localTip: string,
	remoteTip: string,
	env: NodeJS.ProcessEnv,
	opts: RunLocalSyncRoundOpts,
): Promise<LocalSyncResult> {
	const [localIndex, remoteIndex, localPaths, remotePaths] = await Promise.all([
		readIndex(ORPHAN_BRANCH, cwd),
		readIndex(REMOTE_TIP_REF, cwd),
		listFilesInBranch(ORPHAN_BRANCH, "", cwd),
		listFilesInBranch(REMOTE_TIP_REF, "", cwd),
	]);

	const localPathSet = new Set(localPaths);
	const remotePathSet = new Set(remotePaths);
	const remoteOnly = remotePaths.filter((p) => p !== "index.json" && !localPathSet.has(p));
	const shared = remotePaths.filter((p) => p !== "index.json" && localPathSet.has(p) && remotePathSet.has(p));

	const files: FileWrite[] = [];

	if (remoteOnly.length > 0) {
		const remoteContents = await batchReadFilesFromBranch(REMOTE_TIP_REF, remoteOnly, cwd);
		for (const path of remoteOnly) {
			const content = remoteContents.get(path);
			if (content !== null && content !== undefined) {
				files.push({ path, content });
			}
		}
	}

	if (shared.length > 0) {
		const [localShared, remoteShared] = await Promise.all([
			batchReadFilesFromBranch(ORPHAN_BRANCH, shared, cwd),
			batchReadFilesFromBranch(REMOTE_TIP_REF, shared, cwd),
		]);
		const conflictingPaths: string[] = [];
		for (const path of shared) {
			const local = localShared.get(path);
			const remote = remoteShared.get(path);
			if (local === remote) continue; // identical content — nothing to do, local already has it
			conflictingPaths.push(path);
			if (opts.force === "theirs" && remote !== null && remote !== undefined) {
				files.push({ path, content: remote });
			}
			// force === "mine" (or unset, pending abort below): keep local content — no write needed.
		}
		if (conflictingPaths.length > 0 && !opts.force) {
			log.warn(
				"Local Sync: %d shared path(s) differ in content between local and remote — this should be impossible for content-addressed files; aborting without writes: %s",
				conflictingPaths.length,
				conflictingPaths.join(", "),
			);
			await writeLocalSyncConflict(cwd, {
				detectedAt: new Date().toISOString(),
				localTip,
				remoteTip,
				conflictingPaths,
				message: "Shared content-addressed path(s) differ between local and remote Local Sync state.",
			});
			await saveState(cwd, "conflict-unresolved", destBranch, localTip, remoteTip);
			return {
				outcome: "conflict-unresolved",
				errorCode: "conflict",
				destBranch,
				localTip,
				remoteTip,
				message: `${conflictingPaths.length} conflicting path(s): ${conflictingPaths.join(", ")}`,
			};
		}
	}

	const mergedIndex = mergeSummaryIndex(localIndex, remoteIndex);
	files.push({ path: "index.json", content: JSON.stringify(mergedIndex, null, "\t") });

	await writeMergeCommitToBranch(
		ORPHAN_BRANCH,
		localTip,
		remoteTip,
		files,
		`local-sync: merge ${destBranch} (${remoteTip.substring(0, 8)}) into ${ORPHAN_BRANCH}`,
		cwd,
	);

	if (opts.pullOnly) {
		// SessionStart-triggered rounds never push — the merge commit stays
		// local until the next QueueWorker-triggered round pushes it.
		await saveState(cwd, "merged", destBranch, localTip, remoteTip);
		return { outcome: "merged", destBranch, localTip, remoteTip };
	}

	return pushOrphanTip(destUrl, destBranch, cwd, env);
}

/**
 * Runs one Local Sync round for the project at `cwd`. See the module
 * doc-comment for the three call sites and their contracts.
 */
export async function runLocalSyncRound(cwd: string, opts: RunLocalSyncRoundOpts = {}): Promise<LocalSyncResult> {
	if (await readManualDisableFlag(cwd)) {
		return { outcome: "disabled" };
	}

	const config = await loadConfig();
	if (!config.localSyncEnabled || !config.localSyncRepoUrl || !config.localSyncToken) {
		return { outcome: "not-configured" };
	}
	const destUrl = config.localSyncRepoUrl;

	const destBranch = computeDestinationBranchName(cwd);
	const { env } = await prepareAskpass(config.localSyncToken);

	const lockAcquired = await acquireOrphanWriteLock(cwd, { timeoutMs: 15000 });
	if (!lockAcquired) {
		log.warn("Local Sync: could not acquire orphan-write.lock — skipping this round, next trigger retries");
		return { outcome: "error", errorCode: "lock-busy", destBranch, message: "orphan-write.lock busy" };
	}

	try {
		const probe = await lsRemote(destUrl, undefined, cwd, env);
		if (probe.exitCode !== 0) {
			const errorCode = classifyGitError(probe.stderr);
			const outcome: LocalSyncOutcome = errorCode === "network" ? "offline" : "error";
			log.debug("Local Sync: destination unreachable (%s): %s", errorCode ?? "unclassified", probe.stderr);
			await saveState(cwd, outcome, destBranch);
			return { outcome, errorCode, destBranch, message: probe.stderr };
		}

		const fetchResult = await fetchRefspec(destUrl, `+refs/heads/${destBranch}:${REMOTE_TIP_REF}`, cwd, env);
		const remoteBranchExists = fetchResult.exitCode === 0;
		const localTip = await getRevOrNull(`refs/heads/${ORPHAN_BRANCH}`, cwd);
		const remoteTip = remoteBranchExists ? await getRevOrNull(REMOTE_TIP_REF, cwd) : null;

		if (!remoteTip) {
			// Nothing usable on the destination (branch missing, or fetch
			// succeeded but the ref didn't resolve).
			if (!localTip) {
				// Nothing locally either — truly nothing to sync yet.
				return { outcome: "up-to-date", destBranch };
			}
			if (opts.pullOnly) {
				return { outcome: "up-to-date", destBranch, localTip, message: "destination branch doesn't exist yet" };
			}
			return pushOrphanTip(destUrl, destBranch, cwd, env);
		}

		if (!localTip) {
			// Bootstrap: no local orphan branch yet (e.g. a fresh `git clone` on
			// a new machine, before this project's first commit here), but the
			// destination already has history for this project. Create the
			// local orphan branch pointing straight at the remote tip — this is
			// what makes "clone, then just open the project" work without any
			// manual command: the very first SessionStart-triggered pull round
			// populates local history from scratch.
			await execGit(["update-ref", `refs/heads/${ORPHAN_BRANCH}`, remoteTip], cwd);
			await saveState(cwd, "pulled", destBranch, remoteTip, remoteTip);
			return { outcome: "pulled", destBranch, localTip: remoteTip, remoteTip };
		}

		if (localTip === remoteTip) {
			await saveState(cwd, "up-to-date", destBranch, localTip, remoteTip);
			return { outcome: "up-to-date", destBranch, localTip, remoteTip };
		}

		if (await isAncestor(remoteTip, localTip, cwd)) {
			// Local strictly ahead.
			if (opts.pullOnly) {
				return { outcome: "up-to-date", destBranch, localTip, remoteTip, message: "nothing new to pull" };
			}
			return pushOrphanTip(destUrl, destBranch, cwd, env);
		}

		if (await isAncestor(localTip, remoteTip, cwd)) {
			// Remote strictly ahead — fast-forward the LOCAL orphan branch ref so
			// recall/search/MCP see the synced data immediately. This is the
			// actual point of the pull trigger.
			await execGit(["update-ref", `refs/heads/${ORPHAN_BRANCH}`, remoteTip], cwd);
			await saveState(cwd, "pulled", destBranch, remoteTip, remoteTip);
			return { outcome: "pulled", destBranch, localTip: remoteTip, remoteTip };
		}

		// Neither side is an ancestor of the other — true divergence.
		return await resolveDivergence(cwd, destUrl, destBranch, localTip, remoteTip, env, opts);
	} finally {
		await releaseOrphanWriteLock(cwd);
	}
}
