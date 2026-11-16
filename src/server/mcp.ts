/**
 * The custom MCP servers service behind /api/mcp and the chat handler.
 * Configuration: settings.json agent.mcpServers (written only here).
 * Secrets: auth.json's private MCP record (store/auth.ts), never returned:
 * the settings page sees secret NAMES only.
 */

import { randomBytes } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	parseMcpServerFields,
	parseMcpSecrets,
	secretNames,
	type McpAgent,
	type McpServerSecrets,
	type McpServerSettings,
} from "../core/mcp.ts";
import { readMcpSecrets, writeMcpSecrets } from "../store/auth.ts";
import { readSettings, writeSettings } from "../store/settings.ts";
import { mcpPool, type McpServerStatus } from "./mcp-clients.ts";
import { effectiveSettings } from "./stores.ts";

export interface McpServerView extends McpServerSettings {
	secretNames: { env: string[]; headers: string[] };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

const servers = (): McpServerSettings[] => effectiveSettings().agent.mcpServers;

const view = (server: McpServerSettings, secrets: Record<string, McpServerSecrets>): McpServerView =>
	({ ...server, secretNames: secretNames(secrets[server.id]) });

export function listMcpServers(): McpServerView[] {
	const secrets = readMcpSecrets();
	return servers().map((server) => view(server, secrets));
}

function saveServers(next: McpServerSettings[]): void {
	const record = readSettings() ?? { version: 1 };
	const agent = { ...(record.agent ?? {}) };
	if (next.length) agent.mcpServers = next;
	else delete agent.mcpServers;
	writeSettings({ ...record, agent });
}

/**
 * Secrets in a write: { env?: {NAME: value}, headers?: {Name: value} }. The
 * names sent are the complete set; an empty value keeps that name's stored
 * value (the page never holds values), and a name left out is removed.
 */
function mergeSecrets(raw: unknown, previous: McpServerSecrets | undefined): Outcome<McpServerSecrets> {
	const parsed = parseMcpSecrets(raw);
	if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
	const merge = (next: Record<string, string> | undefined, old: Record<string, string> | undefined) => {
		const out: Record<string, string> = {};
		for (const [name, value] of Object.entries(next ?? {})) {
			const kept = value === "" ? old?.[name] : value;
			if (kept !== undefined && kept !== "") out[name] = kept;
		}
		return Object.keys(out).length ? out : undefined;
	};
	const env = merge(parsed.value.env, previous?.env);
	const headers = merge(parsed.value.headers, previous?.headers);
	return { ok: true, value: { ...(env ? { env } : {}), ...(headers ? { headers } : {}) } };
}

function nameTaken(name: string, exceptId?: string): boolean {
	return servers().some((server) => server.id !== exceptId && server.name.toLowerCase() === name.toLowerCase());
}

function asBody(body: unknown): { server?: unknown; secrets?: unknown } {
	return body !== null && typeof body === "object" && !Array.isArray(body) ? body as { server?: unknown; secrets?: unknown } : {};
}

function settle(next: McpServerSettings[], secrets: Record<string, McpServerSecrets>): void {
	writeMcpSecrets(secrets);
	saveServers(next);
	mcpPool().reconcile(next, secrets);
}

export function createMcpServer(body: unknown): Outcome<McpServerView> {
	const { server, secrets: rawSecrets } = asBody(body);
	const fields = parseMcpServerFields(server);
	if (!fields.ok) return { ok: false, status: 400, error: fields.error };
	if (nameTaken(fields.value.name)) return { ok: false, status: 400, error: `a server named "${fields.value.name}" already exists` };
	const merged = mergeSecrets(rawSecrets, undefined);
	if (!merged.ok) return merged;
	const created: McpServerSettings = { id: randomBytes(8).toString("hex"), ...fields.value };
	const secrets = readMcpSecrets();
	if (Object.keys(merged.value).length) secrets[created.id] = merged.value;
	else delete secrets[created.id];
	settle([...servers(), created], secrets);
	return { ok: true, value: view(created, secrets) };
}

export function updateMcpServer(id: string, body: unknown): Outcome<McpServerView> {
	const current = servers();
	const index = current.findIndex((server) => server.id === id);
	if (index < 0) return { ok: false, status: 404, error: "No such MCP server" };
	const { server, secrets: rawSecrets } = asBody(body);
	const fields = parseMcpServerFields(server);
	if (!fields.ok) return { ok: false, status: 400, error: fields.error };
	if (nameTaken(fields.value.name, id)) return { ok: false, status: 400, error: `a server named "${fields.value.name}" already exists` };
	const secrets = readMcpSecrets();
	const merged = mergeSecrets(rawSecrets, secrets[id]);
	if (!merged.ok) return merged;
	if (Object.keys(merged.value).length) secrets[id] = merged.value;
	else delete secrets[id];
	const updated: McpServerSettings = { id, ...fields.value };
	settle(current.map((entry, i) => i === index ? updated : entry), secrets);
	return { ok: true, value: view(updated, secrets) };
}

export function deleteMcpServer(id: string): Outcome<null> {
	const current = servers();
	if (!current.some((server) => server.id === id)) return { ok: false, status: 404, error: "No such MCP server" };
	const secrets = readMcpSecrets();
	delete secrets[id];
	settle(current.filter((server) => server.id !== id), secrets);
	return { ok: true, value: null };
}

/** Live status for the settings page: connects an enabled server to report its tools or error. */
export async function mcpServerStatus(id: string): Promise<Outcome<McpServerStatus>> {
	const server = servers().find((entry) => entry.id === id);
	if (!server) return { ok: false, status: 404, error: "No such MCP server" };
	return { ok: true, value: await mcpPool().status(server, readMcpSecrets()[id] ?? {}) };
}

/**
 * The turn's MCP tools, by agent. A server that fails to connect is logged
 * and left out; it never fails the turn. Names already taken by the app's
 * own tools are skipped (the mcp_ prefix makes that rare).
 */
export async function mcpToolsForTurn(reserved: readonly string[] = []): Promise<Partial<Record<McpAgent, AgentTool<any>[]>>> {
	const configured = servers();
	if (!configured.some((server) => server.enabled)) {
		mcpPool().reconcile(configured, {});
		return {};
	}
	try {
		return await mcpPool().toolsByAgent(configured, readMcpSecrets(), new Set(reserved));
	} catch (error) {
		console.error("[mcp] tools unavailable for this turn:", error);
		return {};
	}
}

