/**
 * Tests for LocalSyncBranchName — collision-safe destination-branch naming
 * for Local Sync's shared destination repo. `getRemoteUrl` / `extractRepoName`
 * from KBPathResolver are spied on (same approach as RepoIdentity.test.ts)
 * so this stays fully offline, no real git needed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as kbResolver from "../core/KBPathResolver.js";
import { computeDestinationBranchName, LOCAL_SYNC_BRANCH_PREFIX } from "./LocalSyncBranchName.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("computeDestinationBranchName", () => {
	it("produces a local-sync/<slug>-<hash6> branch name from a remote URL", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://github.com/foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const name = computeDestinationBranchName("/some/path");

		expect(name.startsWith(`${LOCAL_SYNC_BRANCH_PREFIX}bar-`)).toBe(true);
		// slug + "-" + 6 hex chars
		expect(name).toMatch(/^local-sync\/bar-[0-9a-f]{6}$/);
	});

	it("is deterministic — same repo identity always produces the same branch name", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://github.com/foo/bar.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("bar");

		const first = computeDestinationBranchName("/some/path");
		const second = computeDestinationBranchName("/some/other/checkout/of/the/same/repo");

		expect(first).toBe(second);
	});

	it("disambiguates two different repos that share the same basename", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://github.com/org-a/api.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("api");
		const first = computeDestinationBranchName("/checkout/a");

		vi.restoreAllMocks();
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue("https://gitlab.com/org-b/api.git");
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("api");
		const second = computeDestinationBranchName("/checkout/b");

		expect(first).not.toBe(second);
		expect(first.startsWith(`${LOCAL_SYNC_BRANCH_PREFIX}api-`)).toBe(true);
		expect(second.startsWith(`${LOCAL_SYNC_BRANCH_PREFIX}api-`)).toBe(true);
	});

	it("falls back to the workspace-folder-derived slug when there is no remote", () => {
		vi.spyOn(kbResolver, "getRemoteUrl").mockReturnValue(null);
		vi.spyOn(kbResolver, "extractRepoName").mockReturnValue("my-notes");

		const name = computeDestinationBranchName("/home/foo/my-notes");

		expect(name).toMatch(/^local-sync\/my-notes-[0-9a-f]{6}$/);
	});
});
