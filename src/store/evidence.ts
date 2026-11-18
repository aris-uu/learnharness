/**
 * The global evidence ledger — fs JSONL adapter for core/math-evidence.ts's
 * EvidenceStore: data/evidence/evidence.jsonl, one EvidenceRecord per line.
 * Appends on each successful record_evidence call; rewritten whole only by
 * backfill and chat deletion. Corrupt lines are skipped, never guessed at.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { MATH_DIMENSIONS, MATH_HABITS, MATH_OUTCOMES, type EvidenceRecord, type EvidenceStore } from "../core/math-evidence.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const EVIDENCE_FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "evidence", "evidence.jsonl");

function isRecord(value: unknown): value is EvidenceRecord {
	const r = value as Record<string, unknown> | null;
	return !!r && typeof r === "object" &&
		typeof r.id === "string" && typeof r.chatId === "string" && typeof r.nodeId === "string" &&
		typeof r.nodeTitle === "string" && (r.nodeSummary === undefined || typeof r.nodeSummary === "string") &&
		(MATH_DIMENSIONS as readonly unknown[]).includes(r.dimension) &&
		(MATH_OUTCOMES as readonly unknown[]).includes(r.outcome) &&
		typeof r.hints === "number" && typeof r.note === "string" && typeof r.recordedAt === "string" &&
		(r.habits === undefined || (Array.isArray(r.habits) && r.habits.every((tag) => (MATH_HABITS as readonly unknown[]).includes(tag))));
}

const serialize = (records: readonly EvidenceRecord[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

export function createEvidenceStore(file: string): EvidenceStore {
	const read = (): EvidenceRecord[] => {
		let text: string;
		try { text = fs.readFileSync(file, "utf-8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		const seen = new Set<string>();
		const out: EvidenceRecord[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(line); } catch { continue; }
			if (!isRecord(parsed) || seen.has(parsed.id)) continue;
			seen.add(parsed.id);
			out.push(parsed);
		}
		return out;
	};
	const write = (records: readonly EvidenceRecord[]) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		writeFileAtomicSync(file, serialize(records));
	};
	return {
		exists: () => fs.existsSync(file),
		list: read,
		append(record) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
		},
		replaceAll: write,
		removeChat(chatId) {
			if (!fs.existsSync(file)) return 0;
			const records = read();
			const kept = records.filter((record) => record.chatId !== chatId);
			if (kept.length !== records.length) write(kept);
			return records.length - kept.length;
		},
	};
}

export const evidenceStore = createEvidenceStore(EVIDENCE_FILE);
