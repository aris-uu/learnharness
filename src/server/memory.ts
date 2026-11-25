/**
 * The memory view's data: every global math concept with attempts, its
 * forgetting curve read now, its stage, and the sessions that touched it.
 * Read only — derived from the attempt log on each request
 * (core/memory/items.ts).
 */
import { curvePoints, DEFAULT_DESIRED_RETENTION, storeSnapshot, type MemoryView } from "../core/memory/items.ts";
import { reviewTitle } from "../core/memory/review.ts";
import { stores } from "./stores.ts";

const DAY_MS = 86_400_000;

export function readMemoryView(nowMs = Date.now()): MemoryView {
	const titles = new Map(stores.chatStore.listChats().map((chat) => [chat.id, chat.title]));
	const weights = stores.fsrsWeightsStore.read();
	const items = storeSnapshot(stores.mathStore, nowMs, weights).map((item) => ({
		...item,
		sessionTitle: titles.get(item.chatId) ?? item.chatId,
		curve: item.state ? curvePoints(item, nowMs + 14 * DAY_MS, undefined, weights) : [],
	}));
	return { now: nowMs, retention: DEFAULT_DESIRED_RETENTION, implicitCredit: stores.mathStore.options().implicitCredit, items };
}

/** How many concepts are due now (the badge). */
export function memoryDueCount(nowMs = Date.now()): number {
	return memoryDueSplit(nowMs).due;
}

/** Due concepts by where they go: mature → review, learning and relearning → consolidation. */
export function memoryDueSplit(nowMs = Date.now()): { due: number; mature: number; learning: number; relearning: number } {
	const due = storeSnapshot(stores.mathStore, nowMs, stores.fsrsWeightsStore.read()).filter((item) => item.due);
	const mature = due.filter((item) => item.stage === "mature").length;
	const relearning = due.filter((item) => item.stage === "relearning").length;
	return { due: due.length, mature, learning: due.length - mature, relearning };
}

/** Recall now per concept id, for tinting plan maps (R1). */
export function conceptRecall(ids: readonly string[], nowMs = Date.now()): Record<string, { recall: number | null; stale: boolean; stage: string; due: boolean }> {
	const want = new Set(ids);
	const out: Record<string, { recall: number | null; stale: boolean; stage: string; due: boolean }> = {};
	for (const item of storeSnapshot(stores.mathStore, nowMs, stores.fsrsWeightsStore.read())) {
		if (!want.has(item.id)) continue;
		out[item.id] = { recall: item.state ? Math.round(item.retrievability * 100) / 100 : null, stale: item.stale, stage: item.stage, due: item.due };
	}
	return out;
}

/** The next review session's title: today's date, numbered after the first. */
export function nextReviewTitle(nowMs = Date.now(), prefix: "Review" | "Consolidate" = "Review"): string {
	return reviewTitle(nowMs, stores.chatStore.listChats().filter((chat) => chat.kind === "review").map((chat) => chat.title), prefix);
}
