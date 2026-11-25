"use client";
/**
 * The Memory page's controls (docs/global-concepts-plan.md §4): per row,
 * "Teach" (R2: a math-mode teach draft that starts at the concept), retire /
 * unretire and "Merge into…" (R4: a direct rewrite of every reference, no
 * alias); in the header, the implicit-credit switch (R7, default off).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { stashTeachDraft } from "@/components/math-mode";
import { cn } from "@/lib/utils";

const BUTTON = "rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50";

async function post(body: Record<string, unknown>): Promise<string | null> {
	try {
		const res = await fetch("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		if (res.ok) return null;
		const json = (await res.json().catch(() => null)) as { error?: string } | null;
		return json?.error ?? `Failed (${res.status}).`;
	} catch {
		return "Could not reach the server.";
	}
}

export function ConceptActions({ id, title, retired, others }: { id: string; title: string; retired: boolean; others: ReadonlyArray<{ id: string; title: string }> }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [merging, setMerging] = useState(false);
	const [into, setInto] = useState("");
	const [error, setError] = useState<string | null>(null);
	const run = async (body: Record<string, unknown>) => {
		setBusy(true);
		setError(null);
		const problem = await post(body);
		setBusy(false);
		if (problem) { setError(problem); return; }
		setMerging(false);
		router.refresh();
	};
	const teach = () => {
		if (!stashTeachDraft({ id, title })) { setError("Could not open the draft."); return; }
		router.push("/chat/new");
	};
	const target = others.find((o) => o.id === into);
	return (
		<div className="flex flex-wrap items-center justify-end gap-1" data-testid="concept-actions">
			<button type="button" className={BUTTON} onClick={teach} data-testid="concept-teach" title="Open a math-mode teach session that starts at this concept">Teach</button>
			<button type="button" className={BUTTON} disabled={busy} onClick={() => void run({ action: retired ? "unretire" : "retire", id })} data-testid="concept-retire"
				title={retired ? "Schedule this concept again" : "Stop scheduling this concept (its history stays)"}>
				{retired ? "Unretire" : "Retire"}
			</button>
			{merging ? (
				<span className="flex items-center gap-1">
					<select value={into} onChange={(e) => setInto(e.target.value)} className="max-w-48 rounded-sm border bg-background px-1 py-0.5 text-xs" data-testid="concept-merge-target" aria-label={`Merge ${title} into`}>
						<option value="">Merge into…</option>
						{others.map((o) => <option key={o.id} value={o.id}>{o.title} ({o.id})</option>)}
					</select>
					<button type="button" className={cn(BUTTON, "text-error")} disabled={busy || !target}
						onClick={() => { if (target && window.confirm(`Merge "${title}" into "${target.title}"? Every attempt, plan and course that names ${id} will name ${target.id} instead. This cannot be undone from here.`)) void run({ action: "merge", id, into: target.id }); }}
						data-testid="concept-merge-confirm">Merge</button>
					<button type="button" className={BUTTON} onClick={() => setMerging(false)}>Cancel</button>
				</span>
			) : (
				<button type="button" className={BUTTON} onClick={() => setMerging(true)} data-testid="concept-merge">Merge into…</button>
			)}
			{error && <span role="alert" className="w-full text-right text-xs text-error">{error}</span>}
		</div>
	);
}

export function ImplicitCreditToggle({ on }: { on: boolean }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const flip = async () => {
		setBusy(true);
		setError(null);
		const problem = await post({ action: "options", implicitCredit: !on });
		setBusy(false);
		if (problem) setError(problem); else router.refresh();
	};
	return (
		<span className="inline-flex items-center gap-2">
			<button type="button" role="switch" aria-checked={on} disabled={busy} onClick={() => void flip()} data-testid="implicit-credit-toggle"
				title="When on, a clean U/S/P review of a concept gives each direct prerequisite that is almost due a weak (Hard) review. Turning it off removes the effect from the whole history."
				className={cn("rounded-full border px-2 py-0.5 text-xs", on ? "border-primary text-primary" : "border-border/80 text-muted-foreground hover:text-foreground")}>
				Implicit credit: {on ? "on" : "off"}
			</button>
			{error && <span role="alert" className="text-xs text-error">{error}</span>}
		</span>
	);
}
