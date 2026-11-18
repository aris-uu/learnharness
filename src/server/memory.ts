/**
 * The memory view's data: every math-mode node with evidence, its
 * forgetting curve read now, and its session's title. Read only — derived
 * from the evidence ledger on each request (core/memory/items.ts).
 */
import { curvePoints, DEFAULT_DESIRED_RETENTION, memorySnapshot, type MemoryView } from "../core/memory/items.ts";
import { stores } from "./stores.ts";

const DAY_MS = 86_400_000;

export function readMemoryView(nowMs = Date.now()): MemoryView {
	const titles = new Map(stores.chatStore.listChats().map((chat) => [chat.id, chat.title]));
	const items = memorySnapshot(stores.evidenceStore.list(), nowMs).map((item) => ({
		...item,
		sessionTitle: titles.get(item.chatId) ?? item.chatId,
		curve: item.state ? curvePoints(item, nowMs + 14 * DAY_MS) : [],
	}));
	return { now: nowMs, retention: DEFAULT_DESIRED_RETENTION, items };
}
