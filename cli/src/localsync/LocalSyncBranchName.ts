/**
 * Local Sync destination-branch naming.
 *
 * Local Sync pushes N different local projects' orphan branches into ONE
 * shared private destination repo (the user's own `localSyncRepoUrl`), so
 * each project needs a collision-safe branch name inside that repo. Reuses
 * `computeRepoIdentity` / `computeFallbackHashSuffix` from
 * `cli/src/sync/RepoIdentity.ts` — both are pure functions with zero
 * dependency on the backend (they only import `KBPathResolver.ts`), so
 * reusing them is safe DRY, not a backend coupling.
 */

import { computeFallbackHashSuffix, computeRepoIdentity } from "../sync/RepoIdentity.js";

/** Prefix every Local Sync destination branch carries, so they're easy to find/filter in the destination repo. */
export const LOCAL_SYNC_BRANCH_PREFIX = "local-sync/";

/**
 * Computes the destination-repo branch name for the project at `cwd`:
 * `local-sync/<slug>-<hash6>`. The slug is the human-readable repo name
 * (from `extractRepoName`, via `computeRepoIdentity`); the 6-hex-char suffix
 * is derived from the project's normalized remote URL (or its fallback
 * identity when there's no remote), guaranteeing two differently-owned repos
 * that happen to share a basename (e.g. two orgs both naming a repo `api`)
 * never collide.
 */
export function computeDestinationBranchName(cwd: string): string {
	const identity = computeRepoIdentity(cwd);
	const hash6 = computeFallbackHashSuffix(identity.repoIdentity);
	return `${LOCAL_SYNC_BRANCH_PREFIX}${identity.slug}-${hash6}`;
}
