#!/usr/bin/env node
/**
 * LocalSyncWorker — standalone, detached drain of one Local Sync round.
 *
 * The push side of Local Sync runs in-process inside `QueueWorker.ts` (which
 * is already a detached background process, spawned per commit — see
 * `LocalSyncEngine.ts`'s doc-comment). This file exists for the pull side:
 * `SessionStartHook.ts` has a hard 500ms budget and cannot await a network
 * fetch inline, so it spawns this as its own detached, `unref()`'d process
 * (mirroring `QueueWorker.ts`'s `launchWorker()` / `PrePushWorker.ts`) and
 * moves on immediately. A session's briefing may therefore be a few seconds
 * stale on a slow network — acceptable, and strictly better than blocking
 * session start on a git fetch.
 *
 * `node LocalSyncWorker.js --cwd <repo> --trigger <name>` is also a valid
 * standalone invocation for external orchestrators, matching `PrePushWorker.js`.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTraceId, runWithTrace, TRACE_ID_ENV, traceIdFromEnv } from "../core/TraceContext.js";
import { createLogger } from "../Logger.js";
import { spawnHidden } from "../util/Subprocess.js";
import { runLocalSyncRound } from "./LocalSyncEngine.js";

const log = createLogger("LocalSyncWorker");

/** Drains one Local Sync round. Entry point for the standalone/detached run. */
export async function runLocalSyncWorker(cwd: string, trigger = "session-start"): Promise<void> {
	log.info("LocalSyncWorker(%s): starting round", trigger);
	const pullOnly = trigger === "session-start";
	const result = await runLocalSyncRound(cwd, { pullOnly });
	log.info(
		"LocalSyncWorker(%s): round done — outcome=%s%s%s",
		trigger,
		result.outcome,
		result.errorCode ? ` errorCode=${result.errorCode}` : "",
		result.message ? ` (${result.message})` : "",
	);
}

/**
 * Spawns {@link runLocalSyncWorker} as a detached, fire-and-forget background
 * process. Mirrors `QueueWorker.ts`'s `launchWorker()` exactly: bare
 * `process.execPath` with no Node flags before the script path (the caller
 * may be running on a Node older than the CLI's `engines` floor, and an
 * unrecognized flag would make the child exit immediately, invisibly, since
 * `stdio` is `"ignore"`), `detached: true`, `.unref()`.
 *
 * Resolves `LocalSyncWorker.js` by directory + filename (not `import.meta.url`)
 * so a bundler that inlines this module into a sibling bundle (esbuild/CJS)
 * still spawns the right script regardless of which bundle calls this.
 *
 * Called synchronously from `SessionStartHook.ts`'s `main()`, ahead of the
 * briefing it must render — so unlike `launchWorker` (called from a hook
 * whose own job IS spawning it), a failure here must never propagate: it
 * would abort the whole session-start hook and suppress the briefing over
 * something as inconsequential as a missing dist file or a spawn error.
 * Every step is therefore wrapped, not just the parts expected to fail.
 */
export function spawnLocalSyncWorkerDetached(cwd: string): void {
	try {
		const dir = dirname(fileURLToPath(import.meta.url));
		const scriptPath = join(dir, "LocalSyncWorker.js");

		if (!existsSync(scriptPath)) {
			log.debug("LocalSyncWorker.js not found at %s — skipping spawn (dist may predate Local Sync)", scriptPath);
			return;
		}

		const traceId = getCurrentTraceId();
		const child = spawnHidden(process.execPath, [scriptPath, "--cwd", cwd, "--trigger", "session-start"], {
			detached: true,
			stdio: "ignore",
			cwd,
			...(traceId ? { env: { ...process.env, [TRACE_ID_ENV]: traceId } } : {}),
		});
		/* v8 ignore next -- spawn error only surfaces asynchronously via this listener when the OS rejects the spawn outright (e.g. EMFILE); detached + unref'd, so there is nothing further to do but log */
		child.on("error", (err) => log.debug("Local Sync worker spawn failed: %s", err.message));
		child.unref();
	} catch (err) {
		log.debug("spawnLocalSyncWorkerDetached failed: %s", err instanceof Error ? err.message : String(err));
	}
}

// --- Script entry point (only when run directly, not when imported) ---
/* v8 ignore start */
function isMainScript(): boolean {
	const argv1 = process.argv[1];
	if (process.env.VITEST || !argv1) return false;

	const resolvedArgv = resolve(argv1);
	const resolvedScript = resolve(fileURLToPath(import.meta.url));
	if (resolvedArgv !== resolvedScript) return false;

	// Only auto-run when the entrypoint itself is LocalSyncWorker. esbuild (CJS,
	// no code splitting) can inline this module into sibling bundles, where
	// import.meta.url is aliased to the same __jmImportMetaUrl — without the
	// basename check the guard would fire inside those bundles too. Same
	// pattern as QueueWorker/PrePushWorker.
	const entryName = basename(resolvedArgv).toLowerCase();
	return entryName === "localsyncworker.js" || entryName === "localsyncworker.ts";
}

if (isMainScript()) {
	const args = process.argv.slice(2);
	const cwdIndex = args.indexOf("--cwd");
	const cwd = cwdIndex >= 0 && args[cwdIndex + 1] ? args[cwdIndex + 1] : process.cwd();
	const triggerIndex = args.indexOf("--trigger");
	const trigger = triggerIndex >= 0 && args[triggerIndex + 1] ? args[triggerIndex + 1] : "activation";

	runWithTrace(traceIdFromEnv(), () =>
		runLocalSyncWorker(cwd, trigger).catch((error: unknown) => {
			log.error("LocalSyncWorker fatal error: %s", error instanceof Error ? error.message : String(error));
			process.exit(0); // never signal failure — this is a background sync
		}),
	);
}
/* v8 ignore stop */
