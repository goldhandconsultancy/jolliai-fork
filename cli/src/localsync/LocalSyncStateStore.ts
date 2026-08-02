/**
 * Local Sync's per-project, gitignored state — mirrors the existing
 * `<projectDir>/.jolli/jollimemory/` convention (sessions.json, cursors.json,
 * …) documented in AGENTS.md, just for Local Sync's own two files:
 *
 *   - `local-sync-state.json` — last round's outcome/tips, read by
 *     `jolli status` / `jolli doctor` / the manual command's output.
 *   - `local-sync-conflict.json` — written ONLY on an unresolved divergence
 *     (see `LocalSyncEngine`). Its mere presence is the "clear local signal"
 *     that manual intervention (`jolli local-sync --force-push-mine` /
 *     `--force-take-theirs`) is needed; `jolli doctor` surfaces it as a fail.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../core/AtomicWrite.js";
import { getJolliMemoryDir } from "../Logger.js";
import type { LocalSyncOutcome } from "./LocalSyncTypes.js";

const STATE_FILE = "local-sync-state.json";
const CONFLICT_FILE = "local-sync-conflict.json";

export interface LocalSyncState {
	readonly version: 1;
	readonly lastSyncAt: string;
	readonly lastOutcome: LocalSyncOutcome;
	readonly lastLocalTip?: string;
	readonly lastRemoteTip?: string;
	readonly destBranch?: string;
}

export interface LocalSyncConflictRecord {
	readonly detectedAt: string;
	readonly localTip: string;
	readonly remoteTip: string;
	readonly conflictingPaths: ReadonlyArray<string>;
	readonly message: string;
}

function statePath(cwd: string): string {
	return join(getJolliMemoryDir(cwd), STATE_FILE);
}

function conflictPath(cwd: string): string {
	return join(getJolliMemoryDir(cwd), CONFLICT_FILE);
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await atomicWriteFile(path, JSON.stringify(value, null, "\t"));
}

/** Records the outcome of a completed Local Sync round. Best-effort — a write failure is not fatal to the round. */
export async function saveLocalSyncState(
	cwd: string,
	state: Omit<LocalSyncState, "version" | "lastSyncAt">,
): Promise<void> {
	const full: LocalSyncState = { version: 1, lastSyncAt: new Date().toISOString(), ...state };
	try {
		await writeJson(statePath(cwd), full);
	} catch {
		// Non-critical — state is a display convenience, not a correctness input.
	}
}

/** Reads the last recorded Local Sync round outcome, or null if none exists / it's unreadable. */
export async function readLocalSyncState(cwd: string): Promise<LocalSyncState | null> {
	try {
		return JSON.parse(await readFile(statePath(cwd), "utf-8")) as LocalSyncState;
	} catch {
		return null;
	}
}

/** Records an unresolved divergence. Presence of this file is the durable "needs manual resolution" signal. */
export async function writeLocalSyncConflict(cwd: string, record: LocalSyncConflictRecord): Promise<void> {
	await writeJson(conflictPath(cwd), record);
}

/** Reads the current unresolved-conflict record, or null if there isn't one. */
export async function readLocalSyncConflict(cwd: string): Promise<LocalSyncConflictRecord | null> {
	try {
		return JSON.parse(await readFile(conflictPath(cwd), "utf-8")) as LocalSyncConflictRecord;
	} catch {
		return null;
	}
}

/** Clears the unresolved-conflict marker — called after a successful `--force-push-mine` / `--force-take-theirs`. */
export async function clearLocalSyncConflict(cwd: string): Promise<void> {
	await rm(conflictPath(cwd), { force: true });
}

/** Synchronous existence check for the conflict marker — used by `jolli doctor`'s check list. */
export function localSyncConflictExists(cwd: string): boolean {
	return existsSync(conflictPath(cwd));
}
