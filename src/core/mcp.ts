/**
 * Custom MCP servers: the user's own Model Context Protocol servers, whose
 * tools join the conversation agents they are ticked for. Configuration
 * lives in settings.json (agent.mcpServers); secrets (stdio env vars, HTTP
 * headers) live in the private auth record under MCP_SECRETS_RECORD, never
 * in settings.json. Calls run without approval: enabling a server trusts it.
 */

/** The agents a server can be given to. */
export const MCP_AGENTS = ["prober", "teacher", "practice"] as const;
export type McpAgent = (typeof MCP_AGENTS)[number];

export type McpTransport =
	| { type: "stdio"; command: string; args: string[]; cwd?: string }
	| { type: "http"; url: string };

export interface McpServerSettings {
	/** Server-assigned, stable: keys the secrets record. */
	id: string;
	/** Unique, and the tool-name prefix: letters, digits, _ and -. */
	name: string;
	enabled: boolean;
	transport: McpTransport;
	agents: McpAgent[];
}

/** Secret values: env vars for a stdio server, headers for an HTTP one. */
export interface McpServerSecrets {
	env?: Record<string, string>;
	headers?: Record<string, string>;
}

/** The auth.json entry holding every server's secrets as one JSON string. */
export const MCP_SECRETS_RECORD = "__learnharness_mcp_secrets";

export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ID_PATTERN = /^[a-f0-9]{16}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const TOOL_NAME_MAX = 64;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const asObject = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function parseTransport(raw: unknown): Result<McpTransport> {
	const t = asObject(raw);
	if (!t) return { ok: false, error: "transport must be an object" };
	if (t.type === "stdio") {
		if (typeof t.command !== "string" || !t.command.trim()) return { ok: false, error: "transport.command is required" };
		const args = t.args ?? [];
		if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return { ok: false, error: "transport.args must be a list of strings" };
		if (t.cwd !== undefined && (typeof t.cwd !== "string" || !t.cwd.trim())) return { ok: false, error: "transport.cwd must be a non-empty string" };
		return { ok: true, value: { type: "stdio", command: t.command.trim(), args: args as string[], ...(typeof t.cwd === "string" ? { cwd: t.cwd.trim() } : {}) } };
	}
	if (t.type === "http") {
		if (typeof t.url !== "string") return { ok: false, error: "transport.url is required" };
		let url: URL;
		try { url = new URL(t.url.trim()); } catch { return { ok: false, error: "transport.url is not a valid URL" }; }
		if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "transport.url must be http or https" };
		return { ok: true, value: { type: "http", url: url.toString() } };
	}
	return { ok: false, error: 'transport.type must be "stdio" or "http"' };
}

function parseAgents(raw: unknown): Result<McpAgent[]> {
	if (!Array.isArray(raw)) return { ok: false, error: "agents must be a list" };
	for (const agent of raw) {
		if (!(MCP_AGENTS as readonly unknown[]).includes(agent)) return { ok: false, error: `unknown agent "${String(agent)}" (supported: ${MCP_AGENTS.join(", ")})` };
	}
	return { ok: true, value: MCP_AGENTS.filter((agent) => raw.includes(agent)) };
}

/** Strict parse of one server's editable fields (the write side). */
export function parseMcpServerFields(raw: unknown): Result<Omit<McpServerSettings, "id">> {
	const r = asObject(raw);
	if (!r) return { ok: false, error: "server must be an object" };
	if (typeof r.name !== "string" || !MCP_NAME_PATTERN.test(r.name)) {
		return { ok: false, error: "name must be 1-32 letters, digits, _ or -, starting with a letter or digit" };
	}
	if (typeof r.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
	const transport = parseTransport(r.transport);
	if (!transport.ok) return transport;
	const agents = parseAgents(r.agents);
	if (!agents.ok) return agents;
	return { ok: true, value: { name: r.name, enabled: r.enabled, transport: transport.value, agents: agents.value } };
}

/** Lenient read of the stored list: invalid entries and repeated ids/names drop. */
export function sanitizeMcpServers(raw: unknown): McpServerSettings[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: McpServerSettings[] = [];
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const entry of raw) {
		const id = asObject(entry)?.id;
		const fields = parseMcpServerFields(entry);
		if (typeof id !== "string" || !ID_PATTERN.test(id) || !fields.ok) continue;
		const name = fields.value.name.toLowerCase();
		if (ids.has(id) || names.has(name)) continue;
		ids.add(id);
		names.add(name);
		out.push({ id, ...fields.value });
	}
	return out;
}

function parseStringMap(raw: unknown, pattern: RegExp, field: string): Result<Record<string, string>> {
	if (raw === undefined) return { ok: true, value: {} };
	const r = asObject(raw);
	if (!r) return { ok: false, error: `${field} must be an object` };
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(r)) {
		if (!pattern.test(key)) return { ok: false, error: `${field} name "${key}" is not valid` };
		if (typeof value !== "string") return { ok: false, error: `${field}.${key} must be a string` };
		out[key] = value;
	}
	return { ok: true, value: out };
}

/** Strict parse of one server's secrets (the write side). */
export function parseMcpSecrets(raw: unknown): Result<McpServerSecrets> {
	const r = raw === undefined ? {} : asObject(raw);
	if (!r) return { ok: false, error: "secrets must be an object" };
	const env = parseStringMap(r.env, ENV_NAME_PATTERN, "env");
	if (!env.ok) return env;
	const headers = parseStringMap(r.headers, HEADER_NAME_PATTERN, "headers");
	if (!headers.ok) return headers;
	return {
		ok: true,
		value: {
			...(Object.keys(env.value).length ? { env: env.value } : {}),
			...(Object.keys(headers.value).length ? { headers: headers.value } : {}),
		},
	};
}

/** The stored secrets record (a JSON string), leniently: bad entries drop. */
export function readMcpSecretsRecord(text: string | undefined): Record<string, McpServerSecrets> {
	if (!text) return {};
	let raw: unknown;
	try { raw = JSON.parse(text); } catch { return {}; }
	const r = asObject(raw);
	if (!r) return {};
	const out: Record<string, McpServerSecrets> = {};
	for (const [id, value] of Object.entries(r)) {
		const parsed = parseMcpSecrets(value);
		if (ID_PATTERN.test(id) && parsed.ok) out[id] = parsed.value;
	}
	return out;
}

/** Names only, never values: what the settings page may show. */
export function secretNames(secrets: McpServerSecrets | undefined): { env: string[]; headers: string[] } {
	return { env: Object.keys(secrets?.env ?? {}), headers: Object.keys(secrets?.headers ?? {}) };
}

/** The agent-facing tool name: mcp_<server>_<tool>, provider-safe and at most 64 chars. */
export function mcpToolName(serverName: string, toolName: string): string {
	const safe = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
	return `mcp_${serverName}_${safe}`.slice(0, TOOL_NAME_MAX);
}
