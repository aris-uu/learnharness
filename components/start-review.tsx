"use client";
/**
 * START REVIEW (retention mode, phase 2 — 2026-11-18): the Memory page's
 * button and the sidebar badge. A review starts from the new-session
 * screen (/chat/new?mode=review), like teaching and practice; any number
 * of review sessions a day.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { BrainIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export { REVIEW_OPENING_PROMPT } from "@/components/review-prompt";
export const NEW_REVIEW_HREF = "/chat/new?mode=review";

export function StartReviewButton({ due, className }: { due: number; className?: string }) {
	return (
		<Link
			href={NEW_REVIEW_HREF}
			data-testid="start-review"
			aria-disabled={due === 0 || undefined}
			className={cn("inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent", due === 0 && "opacity-50", className)}
		>
			<BrainIcon className="size-4" />
			{due === 0 ? "Nothing due — review anyway" : `Start review (${due} due)`}
		</Link>
	);
}

/** The sidebar's due count, refreshed on mount and every few minutes. */
export function useMemoryDue(): number | null {
	return useMemoryDueSplit().due;
}

/** The due count split by stage: mature items go to review, the rest to consolidation. */
export function useMemoryDueSplit(): { due: number | null; split: { mature: number; learning: number } | null } {
	const [due, setDue] = useState<number | null>(null);
	const [split, setSplit] = useState<{ mature: number; learning: number } | null>(null);
	useEffect(() => {
		let live = true;
		const load = () => fetch("/api/memory")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { due?: unknown; mature?: unknown; learning?: unknown } | null) => {
				if (live && typeof body?.due === "number") { setDue(body.due); if (typeof body.mature === "number" && typeof body.learning === "number") setSplit({ mature: body.mature, learning: body.learning }); }
			})
			.catch(() => {});
		load();
		const timer = setInterval(load, 5 * 60_000);
		return () => { live = false; clearInterval(timer); };
	}, []);
	return { due, split };
}
