/**
 * RawCopilotChatTranscriptScanner — historical VS Code Copilot Chat transcript
 * indexer for back-fill.
 *
 * Sibling of {@link RawTranscriptScanner} (`./RawTranscriptScanner.js`, Claude):
 * produces entries in the same {@link RawEntry} shape so `CommitAttributor`
 * (`./CommitAttributor.js`) can attribute across both sources uniformly.
 * Unlike Claude's scanner, which globs a single `~/.claude/projects/` tree and
 * filters by a cwd predicate, Copilot Chat session discovery
 * (`CopilotChatSessionDiscoverer.scanCopilotChatSessions`,
 * `../core/CopilotChatSessionDiscoverer.js`) is inherently per-project, so
 * this scans once per worktree root and merges the results. It also passes
 * `maxAgeMs: Infinity` to bypass that discoverer's normal 48h staleness
 * cutoff — the live post-commit flow and the 60s sidebar tick only care about
 * recent sessions, but historical back-fill needs sessions of any age.
 *
 * No file-edit signal: unlike Claude transcripts, a Copilot Chat turn's
 * `response[]` is collapsed to plain text by `CopilotChatTranscriptReader`
 * (`../core/CopilotChatTranscriptReader.js`), so no per-turn edited-file paths
 * are recoverable. Every {@link RawEntry} produced here therefore has empty
 * `editedRel`/`editedBase` — `CommitAttributor`'s file-overlap anchor check
 * never fires for these entries, so a commit attributed purely via Copilot
 * Chat tops out at "low" (time-window) confidence, never "high"
 * (file-overlap). There's also no per-line `gitBranch` (VS Code doesn't record
 * one in the chat session format), so "medium" (branch-match) never fires
 * either. This is an honest limitation of the signal available, not a bug in
 * the attribution model.
 *
 * `sessionId` is prefixed with `copilot-chat:` so a coincidental collision
 * with a Claude session's raw ID (a wholly different ID scheme, so
 * vanishingly unlikely, but cheap to rule out) can never merge two sources'
 * turns into one `CommitAttributor.buildSessions()` group.
 */

import { scanCopilotChatSessions } from "../core/CopilotChatSessionDiscoverer.js";
import { readCopilotChatTranscript } from "../core/CopilotChatTranscriptReader.js";
import { createLogger } from "../Logger.js";
import type { RawEntry } from "./RawTranscriptScanner.js";

const log = createLogger("RawCopilotChatTranscriptScanner");

/**
 * Scans every VS Code Copilot Chat session for each given worktree root (no
 * staleness cutoff) and returns them as {@link RawEntry} lists grouped by
 * (prefixed) sessionId, sorted by timestamp ascending within each session —
 * the same contract {@link scanClaudeTranscripts} (`./RawTranscriptScanner.js`)
 * returns, so `BackfillEngine` (`./BackfillEngine.js`) can merge the two maps
 * directly with `Map.set`.
 *
 * A transcript that fails to read/parse (schema mismatch, mid-write, unknown
 * patch kind) is skipped — one bad session must never block the rest, matching
 * every other transcript reader's policy in this codebase.
 */
export async function scanCopilotChatTranscriptsForBackfill(
	roots: ReadonlyArray<string>,
): Promise<Map<string, RawEntry[]>> {
	const bySession = new Map<string, RawEntry[]>();

	for (const root of roots) {
		const { sessions, error } = await scanCopilotChatSessions(root, Number.POSITIVE_INFINITY);
		if (error) {
			log.warn("Copilot Chat scan error (%s) for %s — sessions excluded: %s", error.kind, root, error.message);
		}

		for (const session of sessions) {
			const sessionId = `copilot-chat:${session.sessionId}`;
			let entries: RawEntry[];
			try {
				entries = await indexTranscript(session.transcriptPath, sessionId, root);
			} catch (err) {
				log.debug(
					"Skipping unreadable Copilot Chat transcript %s: %s",
					session.transcriptPath,
					(err as Error).message,
				);
				continue;
			}
			if (entries.length === 0) continue;
			bySession.set(sessionId, entries);
		}
	}

	log.info("Indexed %d Copilot Chat session(s) across %d worktree root(s)", bySession.size, roots.length);
	return bySession;
}

/** Reads one transcript in full and maps its entries into {@link RawEntry} records. */
async function indexTranscript(transcriptPath: string, sessionId: string, cwd: string): Promise<RawEntry[]> {
	const { entries: turns } = await readCopilotChatTranscript(transcriptPath);

	const entries: RawEntry[] = turns.map((turn, lineNo) => ({
		sessionId,
		transcriptPath,
		source: "copilot-chat",
		lineNo,
		ts: turn.timestamp,
		tsMs: turn.timestamp ? Date.parse(turn.timestamp) : Number.NaN,
		gitBranch: undefined,
		cwd,
		role: turn.role,
		content: turn.content,
		editedRel: [],
		editedBase: [],
	}));

	entries.sort((a, b) => {
		const at = Number.isNaN(a.tsMs) ? Number.POSITIVE_INFINITY : a.tsMs;
		const bt = Number.isNaN(b.tsMs) ? Number.POSITIVE_INFINITY : b.tsMs;
		return at - bt || a.lineNo - b.lineNo;
	});
	return entries;
}
