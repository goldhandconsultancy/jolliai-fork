#!/usr/bin/env node

/**
 * PrepareMsgHook — Git prepare-commit-msg Event Handler
 *
 * Handles squash detection before a commit is created. Writes squash-pending.json
 * so the post-commit hook can enqueue the squash operation for Worker processing.
 *
 * Two squash scenarios:
 *
 * 1. `git merge --squash` (source = "squash"):
 *    Captures the list of squashed commit hashes from SQUASH_MSG and stores
 *    them in `.jolli/jollimemory/squash-pending.json`.
 *
 * 2. `git reset --soft HEAD~N && git commit` (reset-squash):
 *    Detects that the user manually squashed commits via reset --soft by
 *    checking the reflog and ORIG_HEAD. Writes squash-pending.json. Uses 5-layer
 *    validation to prevent false positives.
 *
 * Note: Amend detection has been removed from this hook. It is now handled by
 * post-commit (reflog detection → defer) and post-rewrite (stdin mapping → enqueue).
 *
 * Git invokes this hook with:
 *   process.argv[2] — path to the commit message file
 *   process.argv[3] — source type: "squash", "commit", "message", etc.
 *   process.argv[4] — SHA1 of an existing commit (only for source="commit")
 *
 * SQUASH_MSG format (written by git during merge --squash):
 *   Squashed commit of the following:
 *
 *   commit a1b2c3d4e5f6...
 *   Author: Name <email>
 *
 *       Commit message A
 *
 *   commit b2c3d4e5f6a7...
 *   ...
 */

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeadHash } from "../core/GitOps.js";
import { readManualDisableFlag } from "../core/RepoProfile.js";
import { saveSquashPending } from "../core/SessionTracker.js";
import { createLogger, setLogDir } from "../Logger.js";
import { detectResetSquash, resolveGitDir } from "./GitOperationDetector.js";

const log = createLogger("PrepareMsgHook");

const REQUIRED_PROJECT_DOCS_ENV = "JOLLI_REQUIRED_PROJECT_DOCS";
const AUTO_CREATE_PROJECT_DOCS_ENV = "JOLLI_AUTO_CREATE_PROJECT_DOCS";

function isTruthyEnv(name: string, defaultValue: boolean): boolean {
	const raw = process.env[name];
	if (raw == null) return defaultValue;
	const normalized = raw.trim().toLowerCase();
	if (normalized.length === 0) return defaultValue;
	return !["0", "false", "no", "off"].includes(normalized);
}

function requiredProjectDocsFromEnv(): ReadonlyArray<string> {
	const raw = process.env[REQUIRED_PROJECT_DOCS_ENV];
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

async function missingProjectDocs(cwd: string, requiredDocs: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
	const missing: string[] = [];
	for (const docPath of requiredDocs) {
		try {
			await access(resolve(cwd, docPath), fsConstants.F_OK);
		} catch {
			missing.push(docPath);
		}
	}
	return missing;
}

function placeholderTitle(docPath: string): string {
	const stem = basename(docPath).replace(/\.[^/.]+$/u, "");
	return stem
		.split(/[-_\s]+/u)
		.filter((part) => part.length > 0)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join(" ");
}

function placeholderContent(docPath: string): string {
	const title = placeholderTitle(docPath) || "Project Documentatie";
	return `# ${title}

## Doel
- TODO: Beschrijf het doel van dit document.

## Context
- TODO: Welke context/achtergrond is relevant voor dit projectonderdeel?

## Wat Moet Hier In
- TODO: Voeg de kerninformatie toe die teamleden nodig hebben.
- TODO: Link naar relevante codepaden, services en owners.

## Beslissingen
- [ ] TODO: Leg genomen of open beslissingen vast.

## Acties
- [ ] TODO: Concrete vervolgstappen met eigenaar en datum.
`;
}

async function createMissingProjectDocs(
	cwd: string,
	missingDocs: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
	const created: string[] = [];
	for (const docPath of missingDocs) {
		const absolutePath = resolve(cwd, docPath);
		try {
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, placeholderContent(docPath), { encoding: "utf-8", flag: "wx" });
			created.push(docPath);
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			log.warn("Could not auto-create missing project doc %s: %s", docPath, (error as Error).message);
		}
	}
	return created;
}

async function warnForMissingProjectDocs(cwd: string): Promise<void> {
	const requiredDocs = requiredProjectDocsFromEnv();
	if (requiredDocs.length === 0) return;
	const initialMissing = await missingProjectDocs(cwd, requiredDocs);
	if (initialMissing.length === 0) return;

	const autoCreate = isTruthyEnv(AUTO_CREATE_PROJECT_DOCS_ENV, true);
	const created = autoCreate ? await createMissingProjectDocs(cwd, initialMissing) : [];
	const missing = autoCreate ? await missingProjectDocs(cwd, requiredDocs) : initialMissing;
	if (missing.length === 0 && created.length === 0) return;

	const lines = ["jollimemory: projectdocumentatie-check:"];

	if (missing.length > 0) {
		lines.push("Ontbreekt nog:", ...missing.map((entry) => `  - ${entry}`), "");
	}

	if (created.length > 0) {
		lines.push("Automatisch aangemaakt met placeholders:", ...created.map((entry) => `  - ${entry}`), "");
	}

	lines.push("AI/agent tip: vul deze placeholders meteen aan in dezelfde commit.");
	if (missing.length > 0) {
		lines.push(
			"",
			"Zullen we dit aanmaken of bijwerken? Start met:",
			...missing.map((entry) => `  touch "${entry}"`),
		);
	}
	process.stderr.write(`${lines.join("\n")}\n`);
}

/**
 * Main handler for the prepare-commit-msg hook.
 *
 * @param source - Source type passed by git as argv[3] ("squash" for merge --squash,
 *                 "commit" for amend or -C)
 * @param cwd - Working directory (git repo root)
 * @param oldHash - SHA1 passed by git as argv[4] (only present when source = "commit")
 */
export async function handlePrepareMsgHook(source: string | undefined, cwd: string, _oldHash?: string): Promise<void> {
	setLogDir(cwd);
	log.info("=== Prepare-commit-msg hook started (source: %s) ===", source ?? "");
	if (await readManualDisableFlag(cwd)) {
		log.info("Repository is manually disabled — skipping squash detection");
		return;
	}

	await warnForMissingProjectDocs(cwd);

	// Note: Amend detection has been removed from prepare-commit-msg.
	// It is now handled by post-commit (reflog detection) and post-rewrite (stdin mapping).

	// Handle squash merge: source="squash" means git merge --squash.
	if (source === "squash") {
		try {
			const squashMsgPath = join(resolveGitDir(cwd), "SQUASH_MSG");
			const squashMsg = await readFile(squashMsgPath, "utf-8");
			const sourceHashes = parseSquashMsg(squashMsg);

			if (sourceHashes.length === 0) {
				log.info("No commit hashes found in SQUASH_MSG, skipping");
				log.info("=== Prepare-commit-msg hook finished ===");
				return;
			}

			log.info("Found %d squashed commit hashes in SQUASH_MSG", sourceHashes.length);

			// Capture the current HEAD as the expected parent of the about-to-be-created
			// squash commit. This lets the PostCommitHook Worker detect stale squash-pending
			// files that survived a lock-contention race condition.
			const expectedParentHash = await getHeadHash(cwd);
			await saveSquashPending(sourceHashes, expectedParentHash, cwd);
		} catch (error: unknown) {
			log.error("Failed to process squash merge: %s", (error as Error).message);
		}

		log.info("=== Prepare-commit-msg hook finished ===");
		return;
	}

	// Detect reset-squash: `git reset --soft HEAD~N` followed by `git commit`.
	// This is a non-fatal detection — if it fails, we simply skip it.
	try {
		if (await detectResetSquash(cwd)) {
			log.info("=== Prepare-commit-msg hook finished ===");
			return;
		}
	} catch (error: unknown) {
		log.error("Reset-squash detection failed: %s", (error as Error).message);
	}

	log.debug("Not a squash merge, amend, or reset-squash (source=%s), skipping", source ?? "");
	log.info("=== Prepare-commit-msg hook finished ===");
}

/**
 * Parses SQUASH_MSG content to extract the list of squashed commit hashes.
 * Matches lines of the form "commit <40-char hex hash>".
 */
export function parseSquashMsg(content: string): ReadonlyArray<string> {
	const hashes: string[] = [];
	for (const line of content.split("\n")) {
		const match = line.trim().match(/^commit\s+([a-f0-9]{40})\b/);
		if (match) {
			hashes.push(match[1]);
		}
	}
	return hashes;
}

// --- Script entry point ---
/* v8 ignore start */
function isMainScript(): boolean {
	const scriptPath = fileURLToPath(import.meta.url);
	const argv1 = process.argv[1];
	return !process.env.VITEST && !!argv1 && resolve(argv1) === resolve(scriptPath);
}

if (isMainScript()) {
	// argv[2] = commit message file path (unused — we don't modify it)
	// argv[3] = source type ("squash", "commit", "message", etc.)
	// argv[4] = SHA1 of an existing commit (only present when source = "commit")
	const source = process.argv[3];
	const oldHash = process.argv[4];
	const cwd = process.cwd();

	handlePrepareMsgHook(source, cwd, oldHash).catch((error: unknown) => {
		console.error("[PrepareMsgHook] Fatal error:", error);
		process.exit(1);
	});
}
/* v8 ignore stop */
