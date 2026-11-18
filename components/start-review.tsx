"use client";
/**
 * START REVIEW (retention mode, phase 2 — 2026-11-18): opens today's review
 * session, creating it with an opening prompt when it does not exist yet.
 * One review chat per day; the server returns today's when asked again.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BrainIcon } from "lucide-react";
import { SessionStarter } from "@/components/start-session";
import { cn } from "@/lib/utils";

export const REVIEW_OPENING_PROMPT = "Start today's review.";

/** Open today's review chat: an existing one as is, a new one with the opening prompt. */
export async function startReview(fetchLike: typeof fetch, starter = new SessionStarter()): Promise<string> {
	const res = await fetchLike("/api/memory");
	const status = res.ok ? ((await res.json()) as { todaysReview?: unknown }) : {};
	if (typeof status.todaysReview === "string" && /^[A-Za-z0-9_-]+$/.test(status.todaysReview)) return `/chat/${status.todaysReview}`;
	return starter.start({ title: REVIEW_OPENING_PROMPT, kind: "review" }, fetchLike);
}

export function StartReviewButton({ due, className }: { due: number; className?: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const starter = useRef(new SessionStarter());
	const start = () => {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		startReview(fetch, starter.current)
			.then((target) => router.push(target))
			.catch(() => { setBusy(false); setFailed(true); });
	};
	return (
		<button
			type="button"
			onClick={start}
			disabled={busy || due === 0}
			data-testid="start-review"
			className={cn("inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-50", className)}
		>
			<BrainIcon className="size-4" />
			{failed ? "Could not start — try again" : due === 0 ? "Nothing due" : `Start review (${due} due)`}
		</button>
	);
}

/** The sidebar's due count, refreshed on mount and every few minutes. */
export function useMemoryDue(): number | null {
	const [due, setDue] = useState<number | null>(null);
	useEffect(() => {
		let live = true;
		const load = () => fetch("/api/memory")
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { due?: unknown } | null) => { if (live && typeof body?.due === "number") setDue(body.due); })
			.catch(() => {});
		load();
		const timer = setInterval(load, 5 * 60_000);
		return () => { live = false; clearInterval(timer); };
	}, []);
	return due;
}
