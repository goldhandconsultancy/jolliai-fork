import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A minimal in-memory fake of the `mssql` surface CatalogTools.ts actually
// uses: `ConnectionPool` + `Request` plus the bare type tokens passed to
// `.input()`. Each `.query(text)` call is routed by matching a distinctive
// substring of the SQL text, backed by plain arrays so fixtures are easy to
// seed per test. Modeled on the fake built for
// packages/catalog-core/src/upsert.test.ts, but for reads (ConnectionPool)
// rather than writes (Transaction).
interface FakeProject {
	id: string;
	name: string;
	client: string;
	type: string;
	status: string;
	criticality: string | null;
	repo_url: string | null;
	last_commit_date: Date | null;
	catalog_yaml_hash: string | null;
	updated_at: Date;
}
interface FakeResource {
	id: string;
	type: string;
	name: string;
	environment: string;
}
interface FakeResourceRef {
	project_id: string;
	resource_id: string;
	relation: string;
	detail: string | null;
}
interface FakeExpiration {
	project_id: string;
	kind: string;
	label: string;
	expires_at: Date;
}

function createFakeDb() {
	return {
		projects: [] as FakeProject[],
		resources: [] as FakeResource[],
		resourceRefs: [] as FakeResourceRef[],
		expirations: [] as FakeExpiration[],
	};
}
type FakeDb = ReturnType<typeof createFakeDb>;

let db: FakeDb;
let closedCount = 0;

// References the module-level `db` binding (reassigned fresh in `beforeEach`),
// not a captured snapshot — the classes below must NOT shadow it with a
// same-named parameter, or their closures would freeze on the pre-beforeEach
// (undefined) value since `vi.mock` factories run once at first import.
function installFakeMssql() {
	function like(value: string, pattern: unknown): boolean {
		const needle = String(pattern).replace(/%/g, "").toLowerCase();
		return value.toLowerCase().includes(needle);
	}

	class Request {
		params: Record<string, unknown> = {};
		input(name: string, _type: unknown, value: unknown) {
			this.params[name] = value;
			return this;
		}
		async query(text: string) {
			const t = text.trim();
			if (t.includes("SELECT TOP (@limit)")) {
				const rows = db.projects
					.filter((p) => like(p.name, this.params.q) || like(p.client, this.params.q))
					.sort((a, b) => a.name.localeCompare(b.name))
					.slice(0, this.params.limit as number);
				return { recordset: rows };
			}
			if (t.includes("WHERE id = @id")) {
				const row = db.projects.find((p) => p.id === this.params.id);
				return { recordset: row ? [row] : [] };
			}
			if (t.includes("r.id AS resource_id, r.type AS resource_type")) {
				const rows = db.resourceRefs
					.filter((rr) => rr.project_id === this.params.id)
					.map((rr) => {
						const res = db.resources.find((r) => r.id === rr.resource_id);
						if (!res) throw new Error(`Fake mssql: onbekende resource ${rr.resource_id}`);
						return {
							resource_id: res.id,
							resource_type: res.type,
							resource_name: res.name,
							relation: rr.relation,
							detail: rr.detail,
						};
					})
					.sort(
						(a, b) =>
							a.resource_type.localeCompare(b.resource_type) ||
							a.resource_name.localeCompare(b.resource_name),
					);
				return { recordset: rows };
			}
			if (t.includes("JOIN resources r ON r.id = rr.resource_id") && t.includes("JOIN projects p")) {
				const rows = db.resourceRefs
					.filter((rr) => {
						const res = db.resources.find((r) => r.id === rr.resource_id);
						return res != null && like(res.name, this.params.name);
					})
					.map((rr) => {
						const proj = db.projects.find((p) => p.id === rr.project_id);
						if (!proj) throw new Error(`Fake mssql: onbekend project ${rr.project_id}`);
						return {
							project_id: proj.id,
							project_name: proj.name,
							relation: rr.relation,
							detail: rr.detail,
						};
					})
					.sort((a, b) => a.project_name.localeCompare(b.project_name));
				return { recordset: rows };
			}
			if (t.includes("e.kind, e.label, e.expires_at")) {
				const days = this.params.days as number;
				const threshold = new Date(Date.now() + days * 86_400_000);
				const rows = db.expirations
					.filter((e) => e.expires_at.getTime() <= threshold.getTime())
					.map((e) => {
						const proj = db.projects.find((p) => p.id === e.project_id);
						if (!proj) throw new Error(`Fake mssql: onbekend project ${e.project_id}`);
						return {
							project_id: proj.id,
							project_name: proj.name,
							kind: e.kind,
							label: e.label,
							expires_at: e.expires_at,
						};
					})
					.sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime());
				return { recordset: rows };
			}
			if (t.includes("last_commit_date <= DATEADD")) {
				const days = this.params.days as number;
				const threshold = new Date(Date.now() - days * 86_400_000);
				const rows = db.projects
					.filter((p) => p.last_commit_date != null && p.last_commit_date.getTime() <= threshold.getTime())
					.sort((a, b) => (a.last_commit_date as Date).getTime() - (b.last_commit_date as Date).getTime());
				return { recordset: rows };
			}
			throw new Error(`Fake mssql: onverwachte query: ${t}`);
		}
	}

	class ConnectionPool {
		config: unknown;
		constructor(config: unknown) {
			this.config = config;
		}
		async connect() {
			return this;
		}
		async close() {
			closedCount += 1;
		}
		request() {
			return new Request();
		}
	}

	return {
		default: {
			ConnectionPool,
			NVarChar: "NVarChar",
			Int: "Int",
		},
	};
}

vi.mock("mssql", async () => installFakeMssql());

const { runCatalogSearch, runCatalogGet, runCatalogFindUsage, runCatalogExpiring, runCatalogStale } = await import(
	"./CatalogTools.js"
);

beforeEach(() => {
	db = createFakeDb();
	closedCount = 0;
	process.env.JOLLI_CATALOG_SQL_SERVER = "test-server.database.windows.net";
	process.env.JOLLI_CATALOG_SQL_DATABASE = "catalog";
});

afterEach(() => {
	delete process.env.JOLLI_CATALOG_SQL_SERVER;
	delete process.env.JOLLI_CATALOG_SQL_DATABASE;
});

describe("getPool env guard", () => {
	it("throws when the server/database env vars are not set", async () => {
		delete process.env.JOLLI_CATALOG_SQL_SERVER;
		await expect(runCatalogSearch("/repo", { query: "acme" })).rejects.toThrow(
			/JOLLI_CATALOG_SQL_SERVER en JOLLI_CATALOG_SQL_DATABASE/,
		);
	});
});

describe("runCatalogSearch", () => {
	it("returns a readable line per matching project", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: "high",
			repo_url: null,
			last_commit_date: null,
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const out = await runCatalogSearch("/repo", { query: "amysoft" });
		expect(out.text).toBe("Amysoft Portal (Amysoft) — active, high");
		expect(closedCount).toBe(1);
	});

	it("falls back to 'onbekende criticality' when criticality is null", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: null,
			repo_url: null,
			last_commit_date: null,
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const out = await runCatalogSearch("/repo", { query: "amysoft" });
		expect(out.text).toBe("Amysoft Portal (Amysoft) — active, onbekende criticality");
	});

	it("returns a friendly message for zero hits", async () => {
		const out = await runCatalogSearch("/repo", { query: "nope" });
		expect(out.text).toBe("Geen projecten gevonden voor 'nope'.");
	});

	it("rejects an empty query", async () => {
		await expect(runCatalogSearch("/repo", { query: "  " })).rejects.toThrow(/query` is required/i);
	});
});

describe("runCatalogGet", () => {
	it("renders the project header plus its joined resources", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: "high",
			repo_url: "https://github.com/acme/amysoft",
			last_commit_date: new Date("2026-05-01T00:00:00Z"),
			catalog_yaml_hash: "abc",
			updated_at: new Date(),
		});
		db.resources.push({ id: "sql:amysoft-sql-prod", type: "sql", name: "amysoft-sql-prod", environment: "prod" });
		db.resourceRefs.push({
			project_id: "amysoft",
			resource_id: "sql:amysoft-sql-prod",
			relation: "reads/writes",
			detail: "dbo.Orders",
		});
		const out = await runCatalogGet("/repo", { project_id: "amysoft" });
		expect(out.text).toContain("id: amysoft");
		expect(out.text).toContain("name: Amysoft Portal");
		expect(out.text).toContain("client: Amysoft");
		expect(out.text).toContain("type: webapp");
		expect(out.text).toContain("status: active");
		expect(out.text).toContain("criticality: high");
		expect(out.text).toContain("repo_url: https://github.com/acme/amysoft");
		expect(out.text).toContain("last_commit_date: 2026-05-01");
		expect(out.text).toContain("Resources:");
		expect(out.text).toContain("  sql:amysoft-sql-prod (reads/writes, dbo.Orders)");
		expect(closedCount).toBe(1);
	});

	it("falls back to the raw value when last_commit_date does not parse as a date", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: "high",
			repo_url: null,
			// Deliberately malformed — formatDate must not throw on data this
			// package does not own the schema evolution of, and should surface
			// the raw value instead.
			last_commit_date: "onbekend-formaat" as unknown as Date,
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const out = await runCatalogGet("/repo", { project_id: "amysoft" });
		expect(out.text).toContain("last_commit_date: onbekend-formaat");
	});

	it("shows a placeholder line when the project has no resources", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: "high",
			repo_url: null,
			last_commit_date: null,
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const out = await runCatalogGet("/repo", { project_id: "amysoft" });
		expect(out.text).toContain("(geen resources gekoppeld)");
	});

	it("throws a Dutch 'unknown project' error for an unknown project_id", async () => {
		await expect(runCatalogGet("/repo", { project_id: "does-not-exist" })).rejects.toThrow(
			"Onbekend project: does-not-exist",
		);
		// The pool is still closed even though the lookup failed.
		expect(closedCount).toBe(1);
	});

	it("rejects an empty project_id", async () => {
		await expect(runCatalogGet("/repo", { project_id: " " })).rejects.toThrow(/project_id` is required/i);
	});
});

describe("runCatalogFindUsage", () => {
	it("lists each project referencing the matched resource", async () => {
		db.projects.push(
			{
				id: "amysoft",
				name: "Amysoft Portal",
				client: "Amysoft",
				type: "webapp",
				status: "active",
				criticality: "high",
				repo_url: null,
				last_commit_date: null,
				catalog_yaml_hash: null,
				updated_at: new Date(),
			},
			{
				id: "widgets",
				name: "Widgets API",
				client: "Widgets Co",
				type: "api",
				status: "active",
				criticality: "medium",
				repo_url: null,
				last_commit_date: null,
				catalog_yaml_hash: null,
				updated_at: new Date(),
			},
		);
		db.resources.push({ id: "sql:shared-sql-prod", type: "sql", name: "shared-sql-prod", environment: "prod" });
		db.resourceRefs.push(
			{ project_id: "amysoft", resource_id: "sql:shared-sql-prod", relation: "reads", detail: null },
			{
				project_id: "widgets",
				resource_id: "sql:shared-sql-prod",
				relation: "reads/writes",
				detail: "dbo.Widgets",
			},
		);
		const out = await runCatalogFindUsage("/repo", { resource_name: "shared-sql" });
		expect(out.text).toBe("Amysoft Portal (reads, -)\nWidgets API (reads/writes, dbo.Widgets)");
	});

	it("returns a friendly message when nothing references the resource", async () => {
		const out = await runCatalogFindUsage("/repo", { resource_name: "ghost-sql" });
		expect(out.text).toBe("Geen gebruik gevonden voor resource 'ghost-sql'.");
	});

	it("rejects an empty resource_name", async () => {
		await expect(runCatalogFindUsage("/repo", { resource_name: "" })).rejects.toThrow(
			/resource_name` is required/i,
		);
	});
});

describe("runCatalogExpiring", () => {
	it("lists items expiring within the window, soonest first", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: "high",
			repo_url: null,
			last_commit_date: null,
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const soon = new Date(Date.now() + 5 * 86_400_000);
		const later = new Date(Date.now() + 20 * 86_400_000);
		db.expirations.push(
			{ project_id: "amysoft", kind: "cert", label: "TLS cert", expires_at: later },
			{ project_id: "amysoft", kind: "sp_credential", label: "Deploy SP", expires_at: soon },
		);
		const out = await runCatalogExpiring("/repo", { days: 30 });
		const soonDate = soon.toISOString().slice(0, 10);
		const laterDate = later.toISOString().slice(0, 10);
		expect(out.text).toBe(
			`Deploy SP — Amysoft Portal — verloopt op ${soonDate} (sp_credential)\n` +
				`TLS cert — Amysoft Portal — verloopt op ${laterDate} (cert)`,
		);
	});

	it("defaults to a 30-day window when days is omitted", async () => {
		db.projects.push({
			id: "amysoft",
			name: "Amysoft Portal",
			client: "Amysoft",
			type: "webapp",
			status: "active",
			criticality: "high",
			repo_url: null,
			last_commit_date: null,
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		db.expirations.push({
			project_id: "amysoft",
			kind: "secret",
			label: "API key",
			expires_at: new Date(Date.now() + 29 * 86_400_000),
		});
		const out = await runCatalogExpiring("/repo", {});
		expect(out.text).toContain("API key — Amysoft Portal");
	});

	it("returns a friendly message when nothing expires soon", async () => {
		const out = await runCatalogExpiring("/repo", { days: 30 });
		expect(out.text).toBe("Niets verloopt binnen 30 dagen.");
	});
});

describe("runCatalogStale", () => {
	it("lists projects with no recent commits, oldest last-commit first", async () => {
		db.projects.push(
			{
				id: "old",
				name: "Old Project",
				client: "Legacy Co",
				type: "webapp",
				status: "active",
				criticality: "low",
				repo_url: null,
				last_commit_date: new Date(Date.now() - 400 * 86_400_000),
				catalog_yaml_hash: null,
				updated_at: new Date(),
			},
			{
				id: "fresh",
				name: "Fresh Project",
				client: "New Co",
				type: "webapp",
				status: "active",
				criticality: "low",
				repo_url: null,
				last_commit_date: new Date(),
				catalog_yaml_hash: null,
				updated_at: new Date(),
			},
		);
		const out = await runCatalogStale("/repo", { days: 180 });
		const lastCommit = (db.projects[0]?.last_commit_date as Date).toISOString().slice(0, 10);
		expect(out.text).toBe(`Old Project (Legacy Co) — laatste commit: ${lastCommit}`);
	});

	it("defaults to a 180-day window when days is omitted", async () => {
		db.projects.push({
			id: "old",
			name: "Old Project",
			client: "Legacy Co",
			type: "webapp",
			status: "active",
			criticality: "low",
			repo_url: null,
			last_commit_date: new Date(Date.now() - 200 * 86_400_000),
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const out = await runCatalogStale("/repo", {});
		expect(out.text).toContain("Old Project (Legacy Co)");
	});

	it("returns a friendly message when nothing is stale", async () => {
		db.projects.push({
			id: "fresh",
			name: "Fresh Project",
			client: "New Co",
			type: "webapp",
			status: "active",
			criticality: "low",
			repo_url: null,
			last_commit_date: new Date(),
			catalog_yaml_hash: null,
			updated_at: new Date(),
		});
		const out = await runCatalogStale("/repo", { days: 180 });
		expect(out.text).toBe("Geen stale projecten (langer dan 180 dagen zonder commits).");
	});
});
