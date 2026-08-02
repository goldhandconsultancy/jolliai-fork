/**
 * Local Sync's `index.json` merge — the only aggregate file that lives on
 * the orphan branch (individual `summaries/<hash>.json` /
 * `transcripts/<hash>.json` blobs are content-addressed by commit hash and
 * are unioned directly by `LocalSyncEngine`, never merged field-by-field).
 *
 * This mirrors the tiebreak algorithm of `mergeIndex` in
 * `cli/src/sync/AggregateMerge.ts` (JOLLI-1316 §3.2), reimplemented here
 * directly against `SummaryIndexEntry` (`Types.ts`) rather than importing
 * that function: `AggregateMerge`'s `IndexEntry` type requires a non-optional
 * `treeHash` and narrows `commitType` to `"commit" | "amend"`, while the
 * orphan branch's real `SummaryIndexEntry` has both as optional and
 * `commitType` spans the full `CommitType` union (`squash`, `cherry-pick`,
 * `revert`, `rebase`, …). `mergeIndex`'s logic never branches on either
 * field, so behavior is identical — this avoids an unsafe cast at the type
 * boundary instead of importing across it.
 */

import type { SummaryIndex, SummaryIndexEntry } from "../Types.js";

/**
 * Merges two `index.json` entry lists — dedupe by `commitHash`, with the
 * 2×2 tiebreak:
 *
 * | local.parent | remote.parent | winner |
 * |---|---|---|
 * | set  | set  | newer `generatedAt` (strict `>`, ties keep local) |
 * | null | null | newer `generatedAt` |
 * | set  | null | local |
 * | null | set  | remote |
 *
 * A non-null `parentCommitHash` is a stronger claim than null (the row was
 * generated with full history context), so it always outranks a null-parent
 * row regardless of timestamps. `undefined` (legacy v1 entries, per the
 * field's own doc comment) is treated as "no parent", same as `null`.
 *
 * Output is sorted by `commitHash` for deterministic, byte-identical output
 * across devices — otherwise the next sync round could re-diverge on
 * `index.json`'s array order alone.
 */
export function mergeSummaryIndexEntries(
	local: ReadonlyArray<SummaryIndexEntry>,
	remote: ReadonlyArray<SummaryIndexEntry>,
): SummaryIndexEntry[] {
	const byHash = new Map<string, SummaryIndexEntry>();
	for (const entry of local) byHash.set(entry.commitHash, entry);
	for (const entry of remote) {
		const existing = byHash.get(entry.commitHash);
		if (!existing) {
			byHash.set(entry.commitHash, entry);
			continue;
		}
		const existingHasParent = existing.parentCommitHash != null;
		const incomingHasParent = entry.parentCommitHash != null;
		if (existingHasParent === incomingHasParent) {
			if (entry.generatedAt > existing.generatedAt) {
				byHash.set(entry.commitHash, entry);
			}
		} else if (incomingHasParent) {
			byHash.set(entry.commitHash, entry);
		}
		// else: existing has a parent, incoming doesn't → keep existing.
	}
	return [...byHash.values()].sort((a, b) =>
		a.commitHash < b.commitHash ? -1 : a.commitHash > b.commitHash ? 1 : 0,
	);
}

/**
 * Merges two full `index.json` documents: entries via
 * {@link mergeSummaryIndexEntries}, `commitAliases` via a shallow merge
 * (local wins on key collision — these are pure cache entries, so any valid
 * value is fine either way), and `version` as the max of the two.
 */
export function mergeSummaryIndex(local: SummaryIndex, remote: SummaryIndex): SummaryIndex {
	return {
		version: Math.max(local.version, remote.version) as SummaryIndex["version"],
		entries: mergeSummaryIndexEntries(local.entries, remote.entries),
		...((local.commitAliases || remote.commitAliases) && {
			commitAliases: { ...remote.commitAliases, ...local.commitAliases },
		}),
	};
}
