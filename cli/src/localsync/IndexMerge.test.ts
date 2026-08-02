/**
 * Tests for IndexMerge — Local Sync's `index.json` merge. Mirrors the
 * tiebreak cases pinned in `cli/src/sync/AggregateMerge.test.ts`'s
 * `mergeIndex` suite (same 2×2 parent-presence table), adapted to the real
 * orphan-branch `SummaryIndexEntry` shape (optional `treeHash`, full
 * `CommitType` union, `parentCommitHash` also allowing `undefined`).
 */

import { describe, expect, it } from "vitest";
import type { SummaryIndex, SummaryIndexEntry } from "../Types.js";
import { mergeSummaryIndex, mergeSummaryIndexEntries } from "./IndexMerge.js";

function entry(commitHash: string, overrides: Partial<SummaryIndexEntry> = {}): SummaryIndexEntry {
	return {
		commitHash,
		parentCommitHash: null,
		commitMessage: `msg-${commitHash}`,
		commitDate: "2026-05-01T00:00:00Z",
		branch: "main",
		generatedAt: "2026-05-01T00:00:00Z",
		...overrides,
	};
}

describe("mergeSummaryIndexEntries", () => {
	it("unions entries present on only one side", () => {
		const result = mergeSummaryIndexEntries([entry("a")], [entry("b")]);
		expect(result.map((e) => e.commitHash)).toEqual(["a", "b"]);
	});

	it("both sides null-parent: newer generatedAt wins", () => {
		const local = entry("a", { generatedAt: "2026-05-01T00:00:00Z", commitMessage: "local" });
		const remote = entry("a", { generatedAt: "2026-05-02T00:00:00Z", commitMessage: "remote" });
		const result = mergeSummaryIndexEntries([local], [remote]);
		expect(result).toHaveLength(1);
		expect(result[0].commitMessage).toBe("remote");
	});

	it("both sides null-parent, tie on generatedAt: local wins", () => {
		const local = entry("a", { generatedAt: "2026-05-01T00:00:00Z", commitMessage: "local" });
		const remote = entry("a", { generatedAt: "2026-05-01T00:00:00Z", commitMessage: "remote" });
		const result = mergeSummaryIndexEntries([local], [remote]);
		expect(result[0].commitMessage).toBe("local");
	});

	it("local has a parent, remote doesn't: local wins regardless of timestamps", () => {
		const local = entry("a", {
			parentCommitHash: "p1",
			generatedAt: "2020-01-01T00:00:00Z",
			commitMessage: "local",
		});
		const remote = entry("a", {
			parentCommitHash: null,
			generatedAt: "2030-01-01T00:00:00Z",
			commitMessage: "remote",
		});
		const result = mergeSummaryIndexEntries([local], [remote]);
		expect(result[0].commitMessage).toBe("local");
	});

	it("remote has a parent, local doesn't: remote wins regardless of timestamps", () => {
		const local = entry("a", {
			parentCommitHash: null,
			generatedAt: "2030-01-01T00:00:00Z",
			commitMessage: "local",
		});
		const remote = entry("a", {
			parentCommitHash: "p1",
			generatedAt: "2020-01-01T00:00:00Z",
			commitMessage: "remote",
		});
		const result = mergeSummaryIndexEntries([local], [remote]);
		expect(result[0].commitMessage).toBe("remote");
	});

	it("both sides have a parent: newer generatedAt wins", () => {
		const local = entry("a", {
			parentCommitHash: "p1",
			generatedAt: "2020-01-01T00:00:00Z",
			commitMessage: "local",
		});
		const remote = entry("a", {
			parentCommitHash: "p1",
			generatedAt: "2030-01-01T00:00:00Z",
			commitMessage: "remote",
		});
		const result = mergeSummaryIndexEntries([local], [remote]);
		expect(result[0].commitMessage).toBe("remote");
	});

	it("treats undefined parentCommitHash (legacy v1) the same as null", () => {
		const local = entry("a", {
			parentCommitHash: undefined,
			generatedAt: "2020-01-01T00:00:00Z",
			commitMessage: "local",
		});
		const remote = entry("a", {
			parentCommitHash: "p1",
			generatedAt: "2020-01-01T00:00:00Z",
			commitMessage: "remote",
		});
		const result = mergeSummaryIndexEntries([local], [remote]);
		// remote has a parent, local's undefined parent counts as "no parent" → remote wins
		expect(result[0].commitMessage).toBe("remote");
	});

	it("output is sorted by commitHash for deterministic cross-device output", () => {
		const result = mergeSummaryIndexEntries([entry("z"), entry("a")], [entry("m")]);
		expect(result.map((e) => e.commitHash)).toEqual(["a", "m", "z"]);
	});

	it("preserves fields outside the CommitType/treeHash union that AggregateMerge's IndexEntry can't represent", () => {
		const local = entry("a", { commitType: "squash", treeHash: undefined });
		const result = mergeSummaryIndexEntries([local], []);
		expect(result[0].commitType).toBe("squash");
		expect(result[0].treeHash).toBeUndefined();
	});
});

describe("mergeSummaryIndex", () => {
	it("merges entries, takes the max version, and merges commitAliases with local winning ties", () => {
		const local: SummaryIndex = {
			version: 1,
			entries: [entry("a")],
			commitAliases: { x: "local-value", onlyLocal: "l" },
		};
		const remote: SummaryIndex = {
			version: 3,
			entries: [entry("b")],
			commitAliases: { x: "remote-value", onlyRemote: "r" },
		};

		const merged = mergeSummaryIndex(local, remote);

		expect(merged.version).toBe(3);
		expect(merged.entries.map((e) => e.commitHash)).toEqual(["a", "b"]);
		expect(merged.commitAliases).toEqual({ x: "local-value", onlyLocal: "l", onlyRemote: "r" });
	});

	it("omits commitAliases entirely when neither side has any", () => {
		const local: SummaryIndex = { version: 1, entries: [] };
		const remote: SummaryIndex = { version: 1, entries: [] };
		const merged = mergeSummaryIndex(local, remote);
		expect(merged.commitAliases).toBeUndefined();
	});
});
