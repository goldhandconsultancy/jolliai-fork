/**
 * Local Sync — types shared across the module.
 *
 * Local Sync is a self-hosted alternative to Personal Space Sync
 * (`cli/src/sync/*`): it mirrors this repo's orphan branch
 * (`jollimemory/summaries/v3`) to a dedicated private git repo the user
 * owns, instead of Jolli's hosted backend. Deliberately kept in its own
 * `cli/src/localsync/` directory (not `cli/src/sync/`) so it can never
 * accidentally depend on backend-only code (`BackendClient.ts`,
 * `GitCredentials`, …) — see AGENTS.md for why that backend can't be
 * self-hosted.
 */

/** Outcome of one `runLocalSyncRound` call. */
export type LocalSyncOutcome =
	| "not-configured"
	| "disabled"
	| "up-to-date"
	| "pushed"
	| "pulled"
	| "merged"
	| "conflict-unresolved"
	| "offline"
	| "error";

/** Machine-readable reason for an `"error"` / `"conflict-unresolved"` outcome. */
export type LocalSyncErrorCode = "repo-not-found" | "auth" | "network" | "push-rejected" | "conflict" | "lock-busy";

/** Result of one `runLocalSyncRound` call — always returned, never thrown across the trigger boundary. */
export interface LocalSyncResult {
	readonly outcome: LocalSyncOutcome;
	/** Local orphan branch tip at the time of this round, when resolvable. */
	readonly localTip?: string;
	/** Destination branch tip as last observed via `fetchRefspec`, when resolvable. */
	readonly remoteTip?: string;
	/** Destination-repo branch name this round operated on. */
	readonly destBranch?: string;
	readonly errorCode?: LocalSyncErrorCode;
	/** Human-readable detail, safe to print to the terminal / log. */
	readonly message?: string;
}
