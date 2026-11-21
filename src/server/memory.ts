/**
 * The memory view's data: every math-mode node with evidence, its
 * forgetting curve read now, and its session's title. Read only — derived
 * from the evidence ledger on each request (core/memory/items.ts).
 */
import { curvePoints, DEFAULT_DESIRED_RETENTION, memorySnapshot, memoryStage, type MemoryView } from "../core/memory/items.ts";
import { reviewTitle } from "../core/memory/review.ts";
import { stores } from "./stores.ts";

const DAY_MS = 86_400_000;

export function readMemoryView(nowMs = Date.now()): MemoryView {
	const titles = new Map(stores.chatStore.listChats().map((chat) => [chat.id, chat.title]));
	const weights = stores.fsrsWeightsStore.read();
	const items = memorySnapshot(stores.evidenceStore.list(), nowMs, { reviews: stores.reviewStore.list(), weights }).map((item) => ({
		...item,
		sessionTitle: titles.get(item.chatId) ?? item.chatId,
		curve: item.state ? curvePoints(item, nowMs + 14 * DAY_MS, undefined, weights) : [],
	}));
	return { now: nowMs, retention: DEFAULT_DESIRED_RETENTION, items };
}

/** How many memory items are due now (the review badge), and how many of those are mature or still in learning. */
export function memoryDueCount(nowMs = Date.now()): number {
	return memoryDueSplit(nowMs).due;
}

export function memoryDueSplit(nowMs = Date.now()): { due: number; mature: number; learning: number } {
	const weights = stores.fsrsWeightsStore.read();
	const due = memorySnapshot(stores.evidenceStore.list(), nowMs, { reviews: stores.reviewStore.list(), weights }).filter((item) => item.due);
	const mature = due.filter((item) => memoryStage(item, weights) === "mature").length;
	return { due: due.length, mature, learning: due.length - mature };
}

/** The next review session's title: today's date, numbered after the first. */
export function nextReviewTitle(nowMs = Date.now(), prefix: "Review" | "Consolidate" = "Review"): string {
	return reviewTitle(nowMs, stores.chatStore.listChats().filter((chat) => chat.kind === "review").map((chat) => chat.title), prefix);
}
