import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockScanCopilotChatSessions, mockReadCopilotChatTranscript } = vi.hoisted(() => ({
	mockScanCopilotChatSessions: vi.fn(),
	mockReadCopilotChatTranscript: vi.fn(),
}));

vi.mock("../core/CopilotChatSessionDiscoverer.js", () => ({
	scanCopilotChatSessions: mockScanCopilotChatSessions,
}));
vi.mock("../core/CopilotChatTranscriptReader.js", () => ({
	readCopilotChatTranscript: mockReadCopilotChatTranscript,
}));

import { scanCopilotChatTranscriptsForBackfill } from "./RawCopilotChatTranscriptScanner.js";

const ROOT = "/repo";

function session(sid: string, transcriptPath = `/repo/session-${sid}.jsonl`) {
	return { sessionId: sid, transcriptPath, updatedAt: "2026-06-01T00:00:00.000Z", source: "copilot-chat" as const };
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => {
	vi.resetAllMocks();
});

describe("scanCopilotChatTranscriptsForBackfill", () => {
	it("maps discovered sessions into RawEntry records, prefixing sessionId and stamping cwd", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [session("s1")] });
		mockReadCopilotChatTranscript.mockResolvedValue({
			entries: [
				{ role: "human", content: "hi", timestamp: "2026-06-01T00:00:00.000Z" },
				{ role: "assistant", content: "hello", timestamp: "2026-06-01T00:00:01.000Z" },
			],
			newCursor: {
				transcriptPath: "/repo/session-s1.jsonl",
				lineNumber: 2,
				updatedAt: "2026-06-01T00:00:01.000Z",
			},
			totalLinesRead: 2,
		});

		const result = await scanCopilotChatTranscriptsForBackfill([ROOT]);

		expect(result.size).toBe(1);
		const entries = result.get("copilot-chat:s1");
		expect(entries).toEqual([
			{
				sessionId: "copilot-chat:s1",
				transcriptPath: "/repo/session-s1.jsonl",
				source: "copilot-chat",
				lineNo: 0,
				ts: "2026-06-01T00:00:00.000Z",
				tsMs: Date.parse("2026-06-01T00:00:00.000Z"),
				gitBranch: undefined,
				cwd: ROOT,
				role: "human",
				content: "hi",
				editedRel: [],
				editedBase: [],
			},
			{
				sessionId: "copilot-chat:s1",
				transcriptPath: "/repo/session-s1.jsonl",
				source: "copilot-chat",
				lineNo: 1,
				ts: "2026-06-01T00:00:01.000Z",
				tsMs: Date.parse("2026-06-01T00:00:01.000Z"),
				gitBranch: undefined,
				cwd: ROOT,
				role: "assistant",
				content: "hello",
				editedRel: [],
				editedBase: [],
			},
		]);
	});

	it("passes maxAgeMs: Infinity so historical (>48h) sessions are not filtered out", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [] });
		await scanCopilotChatTranscriptsForBackfill([ROOT]);
		expect(mockScanCopilotChatSessions).toHaveBeenCalledWith(ROOT, { maxAgeMs: Number.POSITIVE_INFINITY });
	});

	it("sorts entries by timestamp ascending regardless of on-disk order", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [session("s1")] });
		mockReadCopilotChatTranscript.mockResolvedValue({
			entries: [
				{ role: "human", content: "second", timestamp: "2026-06-01T00:00:05.000Z" },
				{ role: "human", content: "first", timestamp: "2026-06-01T00:00:01.000Z" },
			],
			newCursor: { transcriptPath: "x", lineNumber: 2, updatedAt: "2026-06-01T00:00:05.000Z" },
			totalLinesRead: 2,
		});

		const result = await scanCopilotChatTranscriptsForBackfill([ROOT]);
		const entries = result.get("copilot-chat:s1");
		expect(entries?.map((e) => e.content)).toEqual(["first", "second"]);
	});

	it("treats a missing timestamp as NaN tsMs and sorts it last", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [session("s1")] });
		mockReadCopilotChatTranscript.mockResolvedValue({
			entries: [
				{ role: "human", content: "timed" },
				{ role: "human", content: "no-timestamp" },
			],
			newCursor: { transcriptPath: "x", lineNumber: 2, updatedAt: "2026-06-01T00:00:05.000Z" },
			totalLinesRead: 2,
		});

		const result = await scanCopilotChatTranscriptsForBackfill([ROOT]);
		const entries = result.get("copilot-chat:s1");
		expect(entries?.[0].content).toBe("timed");
		expect(entries?.[1].content).toBe("no-timestamp");
		expect(entries?.[1].tsMs).toBeNaN();
	});

	it("skips a transcript that fails to read/parse, without dropping other sessions", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [session("bad"), session("good")] });
		mockReadCopilotChatTranscript.mockImplementation(async (path: string) => {
			if (path.includes("bad")) throw new Error("Copilot Chat scan failed (schema): requests is not an array");
			return {
				entries: [{ role: "human", content: "ok", timestamp: "2026-06-01T00:00:00.000Z" }],
				newCursor: { transcriptPath: path, lineNumber: 1, updatedAt: "2026-06-01T00:00:00.000Z" },
				totalLinesRead: 1,
			};
		});

		const result = await scanCopilotChatTranscriptsForBackfill([ROOT]);
		expect(result.has("copilot-chat:bad")).toBe(false);
		expect(result.has("copilot-chat:good")).toBe(true);
	});

	it("skips a session whose transcript has zero entries", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [session("empty")] });
		mockReadCopilotChatTranscript.mockResolvedValue({
			entries: [],
			newCursor: { transcriptPath: "x", lineNumber: 0, updatedAt: "2026-06-01T00:00:00.000Z" },
			totalLinesRead: 0,
		});

		const result = await scanCopilotChatTranscriptsForBackfill([ROOT]);
		expect(result.size).toBe(0);
	});

	it("scans each worktree root independently and merges the results", async () => {
		mockScanCopilotChatSessions.mockImplementation(async (root: string) => ({
			sessions: [session(`sid-${root}`)],
		}));
		mockReadCopilotChatTranscript.mockResolvedValue({
			entries: [{ role: "human", content: "hi", timestamp: "2026-06-01T00:00:00.000Z" }],
			newCursor: { transcriptPath: "x", lineNumber: 1, updatedAt: "2026-06-01T00:00:00.000Z" },
			totalLinesRead: 1,
		});

		const result = await scanCopilotChatTranscriptsForBackfill(["/repo", "/repo-worktree-2"]);

		expect(mockScanCopilotChatSessions).toHaveBeenCalledTimes(2);
		expect(result.size).toBe(2);
		expect(result.get("copilot-chat:sid-/repo")?.[0].cwd).toBe("/repo");
		expect(result.get("copilot-chat:sid-/repo-worktree-2")?.[0].cwd).toBe("/repo-worktree-2");
	});

	it("continues past a discoverer error, excluding that root's sessions but not throwing", async () => {
		mockScanCopilotChatSessions.mockResolvedValueOnce({
			sessions: [],
			error: { kind: "fs", message: "EACCES" },
		});
		await expect(scanCopilotChatTranscriptsForBackfill([ROOT])).resolves.toEqual(new Map());
	});

	it("returns an empty map when no roots have any sessions", async () => {
		mockScanCopilotChatSessions.mockResolvedValue({ sessions: [] });
		const result = await scanCopilotChatTranscriptsForBackfill([ROOT]);
		expect(result.size).toBe(0);
	});
});
