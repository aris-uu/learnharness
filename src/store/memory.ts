/**
 * The review log — fs JSONL adapter for core/memory/review.ts's ReviewStore:
 * data/memory/reviews.jsonl, one ReviewEvent per line, appended by
 * record_review. Schedules are replayed from it on every read, never stored.
 * Rewritten whole only by chat deletion. Corrupt lines are skipped.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { isReviewEvent, type ReviewEvent, type ReviewStore } from "../core/memory/review.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const REVIEWS_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "memory", "reviews.jsonl");

export function createReviewStore(file: string): ReviewStore {
	const read = (): ReviewEvent[] => {
		let text: string;
		try { text = fs.readFileSync(file, "utf-8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		const seen = new Set<string>();
		const out: ReviewEvent[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { continue; }
			if (!isReviewEvent(parsed) || seen.has(parsed.id)) continue;
			seen.add(parsed.id);
			out.push(parsed);
		}
		return out;
	};
	return {
		list: read,
		append(event) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify(event)}\n`, "utf-8");
		},
		removeChat(chatId) {
			if (!fs.existsSync(file)) return 0;
			const events = read();
			const kept = events.filter((e) => e.chatId !== chatId && !e.itemId.startsWith(`${chatId}#`));
			if (kept.length !== events.length) {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				writeFileAtomicSync(file, kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
			}
			return events.length - kept.length;
		},
	};
}

export const reviewStore = createReviewStore(REVIEWS_FILE);
