/**
 * StatusDataService — pure derivations for the Status panel.
 *
 * Currently the status provider renders rows directly from bridge data; the
 * interesting derivations are small enough to fit here without an elaborate
 * snapshot shape. Kept as a namespace of static helpers for symmetry with the
 * other panels and to give the Store a place to route its data through.
 */

import { hasLlmCredentials } from "../../../../cli/src/core/LlmCredentials.js";
import type {
	JolliMemoryConfig,
	StatusInfo,
} from "../../../../cli/src/Types.js";

export interface StatusDerived {
	/**
	 * Whether *some* LLM credential is usable for AI summaries — Anthropic
	 * apiKey/env, Jolli proxy key, local-agent, or a fully configured Azure
	 * Foundry deployment (endpoint + key + deployment). Delegates to the same
	 * `hasLlmCredentials` the CLI's dispatcher uses, so this can never drift
	 * from what `callLlm` would actually accept. Named `hasApiKey` for
	 * backward compatibility with existing callers/tests, not because it only
	 * checks the Anthropic `apiKey` field anymore.
	 */
	readonly hasApiKey: boolean;
	readonly signedIn: boolean;
	readonly allHooksInstalled: boolean;
	readonly hooksDescription: string;
}

// biome-ignore lint/complexity/noStaticOnlyClass: namespace of pure helpers
export class StatusDataService {
	static derive(
		status: StatusInfo | null,
		config: JolliMemoryConfig | null,
	): StatusDerived {
		const parts: Array<string> = [];
		if (status?.gitHookInstalled) {
			parts.push(`${status.prePushHookInstalled ? 5 : 4} Git`);
		}
		if (status?.claudeHookInstalled) {
			parts.push("2 Claude");
		}
		if (status?.geminiHookInstalled) {
			parts.push("1 Gemini CLI");
		}
		return {
			hasApiKey: config != null && hasLlmCredentials(config),
			signedIn: !!config?.authToken,
			allHooksInstalled: !!status?.gitHookInstalled,
			hooksDescription: parts.length > 0 ? parts.join(" + ") : "none installed",
		};
	}
}
