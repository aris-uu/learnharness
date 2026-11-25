/**
 * THE MEMORY VIEW (retention mode, 2026-11-18; global concepts 2026-11-25):
 * every math concept with attempts, its forgetting curve read now and its
 * stage. A pure body (props in, markup out) so it renders server-side and
 * the render suite can pin it; the row controls are client islands
 * (memory-actions.tsx). Design: docs/retention-mode-plan.md §6,
 * docs/global-concepts-plan.md §4.
 */
import Link from "next/link";
import type { MemoryView, MemoryViewItem } from "@/src/core";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ConceptActions, ImplicitCreditToggle } from "@/components/memory-actions";

const STAGE_LABEL = { learning: "learning", mature: "mature", relearning: "relearning" } as const;
/** The stage column (C5): learning and relearning go to consolidation, mature to review. */
export function stageLabel(item: Pick<MemoryViewItem, "stage" | "status" | "retired">): string {
	if (item.retired) return "retired";
	if (item.status === "unverified") return "unverified";
	return STAGE_LABEL[item.stage];
}

const DAY_MS = 86_400_000;

function relativeDays(fromMs: number, toMs: number): string {
	const days = (toMs - fromMs) / DAY_MS;
	if (Math.abs(days) < 1) return days < 0 ? "today" : "within a day";
	const n = Math.round(Math.abs(days));
	return days < 0 ? `${n}d overdue` : `in ${n}d`;
}

/** The recall curve as a small inline SVG: target line dashed, now marked. */
export function RecallSparkline({ item, now, retention, width = 160, height = 32 }: { item: MemoryViewItem; now: number; retention: number; width?: number; height?: number }) {
	if (item.curve.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
	const t0 = item.curve[0]![0];
	const t1 = item.curve.at(-1)![0];
	const x = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * width;
	const y = (r: number) => (1 - r) * (height - 2) + 1;
	const path = item.curve.map(([t, r], i) => `${i === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(r).toFixed(1)}`).join(" ");
	return (
		<svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`Recall curve, now ${Math.round(item.retrievability * 100)}%`} data-testid="recall-sparkline">
			<line x1={0} x2={width} y1={y(retention)} y2={y(retention)} className="stroke-muted-foreground/40" strokeDasharray="2 3" strokeWidth={1} />
			<line x1={x(now)} x2={x(now)} y1={0} y2={height} className="stroke-muted-foreground/60" strokeWidth={1} />
			<path d={path} fill="none" className={item.due ? "stroke-error" : "stroke-primary"} strokeWidth={1.5} />
		</svg>
	);
}

/** `action` is the header slot (the page passes the Start review button). */
export function MemoryTable({ view, filter, action }: { view: MemoryView; filter: "due" | "all"; action?: ReactNode }) {
	const shown = filter === "due" ? view.items.filter((item) => item.due) : view.items;
	const due = view.items.filter((item) => item.due).length;
	const stale = view.items.filter((item) => item.stale).length;
	const unverified = view.items.filter((item) => item.status === "unverified").length;
	const toConsolidate = view.items.filter((item) => item.due && item.stage !== "mature").length;
	const others = view.items.filter((item) => !item.retired).map((item) => ({ id: item.id, title: item.title }));
	return (
		<div className="mx-auto w-full max-w-5xl px-6 py-8" data-testid="memory-view">
			<div className="flex items-center justify-between gap-4">
				<h1 className="font-serif text-2xl">Memory</h1>
				{action}
			</div>
			<p className="mt-1 text-sm text-muted-foreground">
				{view.items.length} concepts · {due} due ({toConsolidate} to consolidate, {due - toConsolidate} to review) · {stale} stale (solid when taught, now below {Math.round(view.retention * 100)}%) · {unverified} unverified
			</p>
			<div className="mt-2"><ImplicitCreditToggle on={view.implicitCredit} /></div>
			<div className="mt-4 flex gap-1 text-xs uppercase tracking-wider">
				{(["due", "all"] as const).map((f) => (
					<Link key={f} href={f === "due" ? "/memory" : "/memory?show=all"} data-testid={`memory-filter-${f}`}
						className={cn("rounded-sm px-2 py-1", filter === f ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
						{f === "due" ? `Due (${due})` : `All (${view.items.length})`}
					</Link>
				))}
			</div>
			{shown.length === 0 ? (
				<p className="mt-8 text-sm text-muted-foreground">{view.items.length === 0 ? "No math-mode attempts yet." : "Nothing is due."}</p>
			) : (
				<table className="mt-4 w-full text-sm">
					<thead>
						<tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
							<th className="py-2 pr-3 font-normal">Concept</th>
							<th className="py-2 pr-3 font-normal">Stage</th>
							<th className="py-2 pr-3 font-normal">Recall now</th>
							<th className="py-2 pr-3 font-normal">Curve</th>
							<th className="py-2 pr-3 font-normal">Due</th>
							<th className="py-2 pr-3 font-normal">Stability</th>
							<th className="py-2 pr-3 font-normal">Credited</th>
							<th className="py-2 font-normal"><span className="sr-only">Actions</span></th>
						</tr>
					</thead>
					<tbody>
						{shown.map((item) => (
							<tr key={item.id} className={cn("border-b border-border/50 align-middle", item.retired && "opacity-50")} data-testid="memory-row">
								<td className="py-2 pr-3">
									<div>{item.title}</div>
									<div className="font-mono text-[10px] text-muted-foreground/70">{item.id}</div>
									<Link href={`/chat/${item.chatId}`} className="text-xs text-muted-foreground hover:text-foreground">{item.sessionTitle}{item.chatIds.length > 1 ? ` +${item.chatIds.length - 1}` : ""}</Link>
								</td>
								<td className="py-2 pr-3 text-xs" data-testid="memory-stage">{stageLabel(item)}</td>
								<td className="py-2 pr-3 font-mono tabular-nums">
									{item.status === "unverified" ? <span className="text-muted-foreground">unverified</span> : `${Math.round(item.retrievability * 100)}%`}
									{item.stale && <span className="ml-1 text-xs text-error">stale</span>}
								</td>
								<td className="py-2 pr-3"><RecallSparkline item={item} now={view.now} retention={view.retention} /></td>
								<td className="py-2 pr-3 text-xs">{item.status === "unverified" ? "verify" : relativeDays(view.now, Date.parse(item.dueAt))}</td>
								<td className="py-2 pr-3 font-mono text-xs tabular-nums">{item.daysTo90 != null ? `${item.daysTo90.toFixed(1)}d` : "—"}</td>
								<td className="py-2 pr-3 font-mono text-xs">{item.credited.join(" ") || "—"}</td>
								<td className="py-2"><ConceptActions id={item.id} title={item.title} retired={item.retired} others={others.filter((o) => o.id !== item.id)} /></td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
