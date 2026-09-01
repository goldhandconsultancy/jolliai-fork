/**
 * Pure MCP tool handlers for the "project catalogus" — a separate, centrally
 * hosted Azure SQL inventory of client projects and the Azure
 * resources/credentials/integrations each one touches. These five tools are
 * read-only lookups against that database, exposed through this CLI's MCP
 * server so a human can ask things like "what breaks if I rotate credential
 * Y" from an AI host without leaving the chat.
 *
 * Same shape as McpTools.ts: plain async functions, no MCP SDK coupling, a
 * plain `Error` on bad input, a plain JSON-serializable object on success —
 * so they are unit-testable in isolation (see CatalogTools.test.ts).
 *
 * Every handler returns `{ text: string }` — a newline-joined, human-readable
 * summary, NOT the raw rows. The catalog build spec is explicit that each
 * tool must read like something to paste straight into a chat answer, not a
 * JSON dump.
 */

import sql from "mssql";

/**
 * Opens one connection pool for a single call and returns it. Callers are
 * responsible for `await pool.close()` in a `finally` — these are infrequent,
 * human-triggered lookups, not a hot path, so there is no benefit to keeping a
 * persistent pool around between calls.
 *
 * Auth is Entra ID only (`DefaultAzureCredential` under the hood, via
 * mssql's `azure-active-directory-default` authentication type) — no
 * password anywhere. `JOLLI_` is this codebase's env var prefix.
 */
async function getPool(): Promise<sql.ConnectionPool> {
	const server = process.env.JOLLI_CATALOG_SQL_SERVER;
	const database = process.env.JOLLI_CATALOG_SQL_DATABASE;
	if (!server || !database) {
		throw new Error("JOLLI_CATALOG_SQL_SERVER en JOLLI_CATALOG_SQL_DATABASE moeten gezet zijn.");
	}
	const pool = new sql.ConnectionPool({
		server,
		database,
		authentication: { type: "azure-active-directory-default", options: {} },
		options: { encrypt: true },
	});
	await pool.connect();
	return pool;
}

/**
 * Renders a SQL date/datetime value (a `Date` from mssql, or occasionally a
 * date-ish string) as `YYYY-MM-DD`. Falls back to the raw string form for
 * anything that does not parse, rather than throwing on unexpected input from
 * a database this package does not own the schema evolution of.
 */
function formatDate(value: unknown): string {
	const date = value instanceof Date ? value : new Date(String(value));
	if (Number.isNaN(date.getTime())) {
		return String(value);
	}
	return date.toISOString().slice(0, 10);
}

interface ProjectSearchRow {
	id: string;
	name: string;
	client: string;
	type: string;
	status: string;
	criticality: string | null;
	repo_url: string | null;
	last_commit_date: unknown;
	updated_at: unknown;
}

export interface CatalogSearchArgs {
	query: string;
}

/** Full-text-ish search over project name/client. Fixed at 20 hits — no `limit` in the public tool schema. */
export async function runCatalogSearch(_cwd: string, args: CatalogSearchArgs): Promise<{ text: string }> {
	if (!args.query || !args.query.trim()) {
		throw new Error("`query` is required");
	}
	const pool = await getPool();
	try {
		const result = await pool
			.request()
			.input("q", sql.NVarChar, `%${args.query}%`)
			.input("limit", sql.Int, 20)
			.query<ProjectSearchRow>(
				`SELECT TOP (@limit) id, name, client, type, status, criticality, repo_url, last_commit_date, updated_at
				FROM projects WHERE name LIKE @q OR client LIKE @q ORDER BY name`,
			);
		const rows = result.recordset;
		if (rows.length === 0) {
			return { text: `Geen projecten gevonden voor '${args.query}'.` };
		}
		const text = rows
			.map((r) => `${r.name} (${r.client}) — ${r.status}, ${r.criticality ?? "onbekende criticality"}`)
			.join("\n");
		return { text };
	} finally {
		await pool.close();
	}
}

interface ProjectRow {
	id: string;
	name: string;
	client: string;
	type: string;
	status: string;
	criticality: string | null;
	repo_url: string | null;
	last_commit_date: unknown;
	catalog_yaml_hash: string | null;
	updated_at: unknown;
}

interface ResourceRefRow {
	resource_id: string;
	resource_type: string;
	resource_name: string;
	relation: string;
	detail: string | null;
}

export interface CatalogGetArgs {
	project_id: string;
}

/** Full project row plus its joined resources. Throws when `project_id` is unknown. */
export async function runCatalogGet(_cwd: string, args: CatalogGetArgs): Promise<{ text: string }> {
	if (!args.project_id || !args.project_id.trim()) {
		throw new Error("`project_id` is required");
	}
	const pool = await getPool();
	try {
		const projectResult = await pool
			.request()
			.input("id", sql.NVarChar, args.project_id)
			.query<ProjectRow>("SELECT * FROM projects WHERE id = @id");
		const project = projectResult.recordset[0];
		if (!project) {
			throw new Error(`Onbekend project: ${args.project_id}`);
		}
		const resourcesResult = await pool
			.request()
			.input("id", sql.NVarChar, args.project_id)
			.query<ResourceRefRow>(
				`SELECT r.id AS resource_id, r.type AS resource_type, r.name AS resource_name, rr.relation, rr.detail
				FROM resource_refs rr JOIN resources r ON r.id = rr.resource_id
				WHERE rr.project_id = @id ORDER BY r.type, r.name`,
			);
		const header = [
			`id: ${project.id}`,
			`name: ${project.name}`,
			`client: ${project.client}`,
			`type: ${project.type}`,
			`status: ${project.status}`,
			`criticality: ${project.criticality ?? "onbekend"}`,
			`repo_url: ${project.repo_url ?? "-"}`,
			`last_commit_date: ${project.last_commit_date ? formatDate(project.last_commit_date) : "-"}`,
		].join("\n");
		const resources = resourcesResult.recordset;
		const resourceLines =
			resources.length === 0
				? "  (geen resources gekoppeld)"
				: resources
						.map((r) => `  ${r.resource_type}:${r.resource_name} (${r.relation}, ${r.detail ?? "-"})`)
						.join("\n");
		return { text: `${header}\n\nResources:\n${resourceLines}` };
	} finally {
		await pool.close();
	}
}

interface UsageRow {
	project_id: string;
	project_name: string;
	relation: string;
	detail: string | null;
}

export interface CatalogFindUsageArgs {
	resource_name: string;
}

/** Which projects reference a resource, fuzzy-matched by name (e.g. "what breaks if I rotate credential Y"). */
export async function runCatalogFindUsage(_cwd: string, args: CatalogFindUsageArgs): Promise<{ text: string }> {
	if (!args.resource_name || !args.resource_name.trim()) {
		throw new Error("`resource_name` is required");
	}
	const pool = await getPool();
	try {
		const result = await pool
			.request()
			.input("name", sql.NVarChar, `%${args.resource_name}%`)
			.query<UsageRow>(
				`SELECT p.id AS project_id, p.name AS project_name, rr.relation, rr.detail
				FROM resource_refs rr
				JOIN resources r ON r.id = rr.resource_id
				JOIN projects p ON p.id = rr.project_id
				WHERE r.name LIKE @name
				ORDER BY p.name`,
			);
		const rows = result.recordset;
		if (rows.length === 0) {
			return { text: `Geen gebruik gevonden voor resource '${args.resource_name}'.` };
		}
		const text = rows.map((r) => `${r.project_name} (${r.relation}, ${r.detail ?? "-"})`).join("\n");
		return { text };
	} finally {
		await pool.close();
	}
}

interface ExpiringRow {
	project_id: string;
	project_name: string;
	kind: string;
	label: string;
	expires_at: unknown;
}

export interface CatalogExpiringArgs {
	days?: number;
}

/** Certs / secrets / SP credentials expiring within `days` (default 30), soonest first. */
export async function runCatalogExpiring(_cwd: string, args: CatalogExpiringArgs): Promise<{ text: string }> {
	const days = args.days ?? 30;
	const pool = await getPool();
	try {
		const result = await pool
			.request()
			.input("days", sql.Int, days)
			.query<ExpiringRow>(
				`SELECT p.id AS project_id, p.name AS project_name, e.kind, e.label, e.expires_at
				FROM expirations e JOIN projects p ON p.id = e.project_id
				WHERE e.expires_at <= DATEADD(day, @days, SYSUTCDATETIME())
				ORDER BY e.expires_at`,
			);
		const rows = result.recordset;
		if (rows.length === 0) {
			return { text: `Niets verloopt binnen ${days} dagen.` };
		}
		const text = rows
			.map((r) => `${r.label} — ${r.project_name} — verloopt op ${formatDate(r.expires_at)} (${r.kind})`)
			.join("\n");
		return { text };
	} finally {
		await pool.close();
	}
}

export interface CatalogStaleArgs {
	days?: number;
}

/** Projects with no commit activity in `days` (default 180) — candidates for archival / decommission review. */
export async function runCatalogStale(_cwd: string, args: CatalogStaleArgs): Promise<{ text: string }> {
	const days = args.days ?? 180;
	const pool = await getPool();
	try {
		const result = await pool
			.request()
			.input("days", sql.Int, days)
			.query<ProjectRow>(
				`SELECT * FROM projects
				WHERE last_commit_date IS NOT NULL AND last_commit_date <= DATEADD(day, -@days, SYSUTCDATETIME())
				ORDER BY last_commit_date`,
			);
		const rows = result.recordset;
		if (rows.length === 0) {
			return { text: `Geen stale projecten (langer dan ${days} dagen zonder commits).` };
		}
		const text = rows
			.map((r) => `${r.name} (${r.client}) — laatste commit: ${formatDate(r.last_commit_date)}`)
			.join("\n");
		return { text };
	} finally {
		await pool.close();
	}
}
