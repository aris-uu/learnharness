"use client";
/**
 * Settings → Agent → MCP servers: the user's custom MCP servers (/api/mcp).
 * Each server is stdio (a local command) or Streamable HTTP (a URL), is
 * given to the agents ticked for it, and runs its tools without approval.
 * Secret values (env vars, headers) are write-only: the page shows names,
 * and an empty value on edit keeps the stored one.
 */

import { useCallback, useEffect, useState } from "react";
import { MCP_AGENTS, MCP_NAME_PATTERN, type McpAgent, type McpServerSettings } from "@/src/core";
import { cn } from "@/lib/utils";
import { SettingsGroup, ThinSelect, Toggle } from "./controls.tsx";

interface ServerView extends McpServerSettings {
	secretNames: { env: string[]; headers: string[] };
}

type Status =
	| { state: "checking" }
	| { state: "disabled" }
	| { state: "connected"; tools: { name: string; description?: string }[] }
	| { state: "error"; error: string };

const AGENT_LABELS: Record<McpAgent, string> = { prober: "Prober", teacher: "Teacher", practice: "Practice" };

interface SecretRow { name: string; value: string; stored: boolean }

interface Draft {
	name: string;
	enabled: boolean;
	type: "stdio" | "http";
	command: string;
	args: string;
	cwd: string;
	url: string;
	agents: McpAgent[];
	secrets: SecretRow[];
}

const emptyDraft = (): Draft => ({
	name: "", enabled: true, type: "stdio", command: "", args: "", cwd: "", url: "", agents: ["prober", "teacher"], secrets: [],
});

function draftOf(server: ServerView): Draft {
	const t = server.transport;
	const names = t.type === "stdio" ? server.secretNames.env : server.secretNames.headers;
	return {
		name: server.name,
		enabled: server.enabled,
		type: t.type,
		command: t.type === "stdio" ? t.command : "",
		args: t.type === "stdio" ? t.args.join("\n") : "",
		cwd: t.type === "stdio" ? t.cwd ?? "" : "",
		url: t.type === "http" ? t.url : "",
		agents: server.agents,
		secrets: names.map((name) => ({ name, value: "", stored: true })),
	};
}

/** The write body. Secret names sent are the complete set; "" keeps a stored value. */
function bodyOf(draft: Draft) {
	const transport = draft.type === "stdio"
		? {
			type: "stdio" as const,
			command: draft.command.trim(),
			args: draft.args.split("\n").map((arg) => arg.trim()).filter(Boolean),
			...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
		}
		: { type: "http" as const, url: draft.url.trim() };
	const secrets = Object.fromEntries(draft.secrets.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]));
	return {
		server: { name: draft.name.trim(), enabled: draft.enabled, transport, agents: draft.agents },
		secrets: draft.type === "stdio" ? { env: secrets } : { headers: secrets },
	};
}

/** Keep the stored secret values untouched (a toggle or an unedited save). */
function keepSecretsBody(server: ServerView, enabled: boolean) {
	const keep = (names: string[]) => Object.fromEntries(names.map((name) => [name, ""]));
	const { id: _id, secretNames, ...fields } = server;
	return { server: { ...fields, enabled }, secrets: { env: keep(secretNames.env), headers: keep(secretNames.headers) } };
}

function transportSummary(server: McpServerSettings): string {
	const t = server.transport;
	return t.type === "http" ? t.url : [t.command, ...t.args].join(" ");
}

async function errorOf(res: Response): Promise<string> {
	const body = await res.json().catch(() => null) as { error?: string } | null;
	return body?.error ?? `Request failed (${res.status})`;
}

const inputClass = "min-w-0 rounded-sm border border-border bg-background px-2 py-1 font-ui text-xs text-foreground outline-none placeholder:text-muted-foreground/60";
const buttonClass = "rounded-sm border border-border px-2 py-0.5 text-xs disabled:opacity-40";

export function McpServersGroup() {
	const [servers, setServers] = useState<ServerView[] | null>(null);
	const [statuses, setStatuses] = useState<Record<string, Status>>({});
	const [editing, setEditing] = useState<string | null>(null); // a server id, or "new"
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);

	const check = useCallback((server: ServerView) => {
		if (!server.enabled) { setStatuses((s) => ({ ...s, [server.id]: { state: "disabled" } })); return; }
		setStatuses((s) => ({ ...s, [server.id]: { state: "checking" } }));
		fetch(`/api/mcp/status?id=${encodeURIComponent(server.id)}`)
			.then(async (res) => res.ok ? (await res.json()).status as Status : { state: "error", error: await errorOf(res) } as Status)
			.catch((err: unknown) => ({ state: "error", error: err instanceof Error ? err.message : String(err) }) as Status)
			.then((status) => setStatuses((s) => ({ ...s, [server.id]: status })));
	}, []);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/mcp");
			if (!res.ok) { setError(await errorOf(res)); return; }
			const list = (await res.json()).servers as ServerView[];
			setServers(list);
			for (const server of list) check(server);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [check]);

	useEffect(() => { void load(); }, [load]);

	const write = async (method: "POST" | "PUT" | "DELETE", id: string | null, body?: unknown): Promise<boolean> => {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(id ? `/api/mcp?id=${encodeURIComponent(id)}` : "/api/mcp", {
				method,
				...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
			});
			if (!res.ok) { setError(await errorOf(res)); return false; }
			await load();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setSaving(false);
		}
	};

	const startEdit = (server: ServerView | null) => {
		setError(null);
		setEditing(server ? server.id : "new");
		setDraft(server ? draftOf(server) : emptyDraft());
	};

	const save = async () => {
		if (!MCP_NAME_PATTERN.test(draft.name.trim())) { setError("Name: 1-32 letters, digits, _ or -, starting with a letter or digit."); return; }
		const ok = editing === "new" ? await write("POST", null, bodyOf(draft)) : await write("PUT", editing, bodyOf(draft));
		if (ok) setEditing(null);
	};

	const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
	const secretLabel = draft.type === "stdio" ? "Environment variables" : "Headers";

	return (
		<SettingsGroup label="MCP servers" testid="group-mcp">
			<p className="text-xs text-muted-foreground/70">
				Your own MCP servers. Their tools go to the agents you tick, and run without asking: add only servers you trust.
			</p>
			{servers === null && !error && <p className="text-xs text-muted-foreground/70">Loading MCP servers…</p>}
			{servers?.length === 0 && editing === null && <p className="text-xs text-muted-foreground/70">No MCP servers yet.</p>}
			{servers?.map((server) => {
				const status = statuses[server.id];
				const removing = confirmRemove === server.id;
				return (
					<div key={server.id} data-testid="mcp-server" className="flex flex-col gap-1 rounded-sm border border-border/60 px-3 py-2">
						<div className="flex items-center justify-between gap-3">
							<span className="min-w-0">
								<span className="block font-prose text-(length:--lh-prose-size)">{server.name}</span>
								<span title={transportSummary(server)} className="block truncate font-ui text-xs text-muted-foreground/70">
									{server.transport.type === "http" ? "HTTP" : "stdio"} · {transportSummary(server)}
								</span>
							</span>
							<Toggle checked={server.enabled} label={`MCP server ${server.name}`} disabled={saving}
								onChange={(on) => { void write("PUT", server.id, keepSecretsBody(server, on)); }} />
						</div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
							<span>{server.agents.length ? server.agents.map((a) => AGENT_LABELS[a]).join(", ") : "No agents"}</span>
							<span data-testid="mcp-server-status" className={cn(status?.state === "error" && "text-error")}>
								{!status || status.state === "checking" ? "Checking…"
									: status.state === "disabled" ? "Off"
									: status.state === "error" ? "Not connected"
									: `Connected · ${status.tools.length} tool${status.tools.length === 1 ? "" : "s"}`}
							</span>
							<span className="ml-auto flex gap-1">
								{status?.state === "connected" && status.tools.length > 0 && (
									<button type="button" className={buttonClass} onClick={() => setExpanded(expanded === server.id ? null : server.id)}>
										{expanded === server.id ? "Hide tools" : "Tools"}
									</button>
								)}
								{server.enabled && <button type="button" className={buttonClass} disabled={status?.state === "checking"} onClick={() => check(server)}>Retry</button>}
								<button type="button" className={buttonClass} disabled={saving} onClick={() => startEdit(server)}>Edit</button>
								<button type="button" className={buttonClass} disabled={saving}
									onClick={() => {
										if (!removing) { setConfirmRemove(server.id); return; }
										setConfirmRemove(null);
										void write("DELETE", server.id);
									}}
									onBlur={() => { if (removing) setConfirmRemove(null); }}>
									{removing ? "Confirm remove" : "Remove"}
								</button>
							</span>
						</div>
						{status?.state === "error" && (
							<pre role="alert" className="max-h-32 overflow-auto whitespace-pre-wrap font-ui text-xs text-error">{status.error}</pre>
						)}
						{expanded === server.id && status?.state === "connected" && (
							<ul className="flex flex-col gap-0.5 pl-2 text-xs">
								{status.tools.map((tool) => (
									<li key={tool.name}><span className="font-ui">{tool.name}</span>{tool.description && <span className="text-muted-foreground/70"> · {tool.description}</span>}</li>
								))}
							</ul>
						)}
					</div>
				);
			})}
			{editing !== null ? (
				<div data-testid="mcp-server-form" className="flex flex-col gap-2 rounded-sm border border-border px-3 py-3 text-xs">
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-muted-foreground">Name</span>
						<input aria-label="MCP server name" value={draft.name} placeholder="e.g. wolfram" onChange={(e) => update({ name: e.target.value })} className={cn(inputClass, "flex-1")} />
					</label>
					<label className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-muted-foreground">Transport</span>
						<ThinSelect ariaLabel="MCP transport" value={draft.type} onChange={(type) => update({ type: type as Draft["type"], secrets: [] })}>
							<option value="stdio">stdio (local command)</option>
							<option value="http">Streamable HTTP (URL)</option>
						</ThinSelect>
					</label>
					{draft.type === "stdio" ? (
						<>
							<label className="flex items-center gap-2">
								<span className="w-24 shrink-0 text-muted-foreground">Command</span>
								<input aria-label="MCP command" value={draft.command} placeholder="npx" onChange={(e) => update({ command: e.target.value })} className={cn(inputClass, "flex-1")} />
							</label>
							<label className="flex items-start gap-2">
								<span className="w-24 shrink-0 pt-1 text-muted-foreground">Arguments</span>
								<textarea aria-label="MCP arguments" value={draft.args} rows={3} placeholder={"One per line\n-y\n@scope/server"} onChange={(e) => update({ args: e.target.value })} className={cn(inputClass, "flex-1 resize-y")} />
							</label>
							<label className="flex items-center gap-2">
								<span className="w-24 shrink-0 text-muted-foreground">Working folder</span>
								<input aria-label="MCP working folder" value={draft.cwd} placeholder="Optional" onChange={(e) => update({ cwd: e.target.value })} className={cn(inputClass, "flex-1")} />
							</label>
						</>
					) : (
						<label className="flex items-center gap-2">
							<span className="w-24 shrink-0 text-muted-foreground">URL</span>
							<input aria-label="MCP URL" value={draft.url} placeholder="https://example.com/mcp" onChange={(e) => update({ url: e.target.value })} className={cn(inputClass, "flex-1")} />
						</label>
					)}
					<div className="flex items-center gap-2">
						<span className="w-24 shrink-0 text-muted-foreground">Agents</span>
						{MCP_AGENTS.map((agent) => (
							<label key={agent} className="flex items-center gap-1">
								<input type="checkbox" checked={draft.agents.includes(agent)}
									onChange={(e) => update({ agents: e.target.checked ? MCP_AGENTS.filter((a) => a === agent || draft.agents.includes(a)) : draft.agents.filter((a) => a !== agent) })} />
								{AGENT_LABELS[agent]}
							</label>
						))}
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground">{secretLabel} <span className="text-muted-foreground/60">(stored privately, never shown again)</span></span>
						{draft.secrets.map((row, index) => (
							<div key={index} className="flex gap-2">
								<input aria-label={`${secretLabel} name`} value={row.name} placeholder="Name" disabled={row.stored}
									onChange={(e) => update({ secrets: draft.secrets.map((r, i) => i === index ? { ...r, name: e.target.value } : r) })}
									className={cn(inputClass, "w-40")} />
								<input aria-label={`${secretLabel} value`} type="password" value={row.value} placeholder={row.stored ? "Unchanged" : "Value"}
									onChange={(e) => update({ secrets: draft.secrets.map((r, i) => i === index ? { ...r, value: e.target.value } : r) })}
									className={cn(inputClass, "flex-1")} />
								<button type="button" className={buttonClass} aria-label={`Remove ${row.name || "entry"}`}
									onClick={() => update({ secrets: draft.secrets.filter((_, i) => i !== index) })}>Remove</button>
							</div>
						))}
						<button type="button" className={cn(buttonClass, "self-start")} onClick={() => update({ secrets: [...draft.secrets, { name: "", value: "", stored: false }] })}>
							Add {draft.type === "stdio" ? "variable" : "header"}
						</button>
					</div>
					<div className="flex justify-end gap-2">
						<button type="button" className={buttonClass} disabled={saving} onClick={() => { setEditing(null); setError(null); }}>Cancel</button>
						<button type="button" className={buttonClass} disabled={saving} onClick={() => { void save(); }}>{editing === "new" ? "Add server" : "Save"}</button>
					</div>
				</div>
			) : (
				<button type="button" data-testid="mcp-add" className={cn(buttonClass, "self-start")} disabled={servers === null} onClick={() => startEdit(null)}>Add MCP server</button>
			)}
			{error && <p role="alert" className="text-xs text-error">{error}</p>}
		</SettingsGroup>
	);
}
