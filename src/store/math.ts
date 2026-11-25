/**
 * The math data — fs adapter for core/math-concepts.ts's MathStore
 * (docs/global-concepts-plan.md §2):
 *   data/math/concepts.json    the concept graph, written whole (atomic)
 *   data/math/attempts.jsonl   every graded attempt, append-only
 *   data/math/unverified.jsonl old `assumed` notes (migration only, never scheduled)
 *   data/math/merges.jsonl     one line per concept merge (audit)
 * Corrupt lines are skipped, never guessed at. A corrupt concepts file is an
 * error, not an empty graph: silently starting over would orphan the log.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	DEFAULT_MATH_OPTIONS, emptyConceptGraph, isAttempt, isConceptGraph, isUnverifiedNote,
	type Attempt, type ConceptGraph, type MathOptions, type MathStore, type UnverifiedNote,
} from "../core/math-concepts.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const MATH_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "math");

export interface MathFiles { concepts: string; attempts: string; unverified: string; merges: string; options: string }
export const mathFiles = (dir: string): MathFiles => ({
	options: path.join(dir, "options.json"),
	concepts: path.join(dir, "concepts.json"),
	attempts: path.join(dir, "attempts.jsonl"),
	unverified: path.join(dir, "unverified.jsonl"),
	merges: path.join(dir, "merges.jsonl"),
});

function readLines<T>(file: string, guard: (v: unknown) => v is T & { id: string }): T[] {
	let text: string;
	try { text = fs.readFileSync(file, "utf-8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	const seen = new Set<string>();
	const out: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try { parsed = JSON.parse(line); } catch { continue; }
		if (!guard(parsed) || seen.has(parsed.id)) continue;
		seen.add(parsed.id);
		out.push(parsed);
	}
	return out;
}

const jsonl = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

export function createMathStore(dir: string): MathStore & { logMerge(entry: Record<string, unknown>): void; files: MathFiles } {
	const files = mathFiles(dir);
	const writeLines = (file: string, rows: readonly unknown[]) => {
		fs.mkdirSync(dir, { recursive: true });
		writeFileAtomicSync(file, jsonl(rows));
	};
	const graph = (): ConceptGraph => {
		let text: string;
		try { text = fs.readFileSync(files.concepts, "utf-8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConceptGraph(); throw error; }
		const parsed: unknown = JSON.parse(text);
		if (!isConceptGraph(parsed)) throw new Error(`${files.concepts} is not a valid concept graph (format 1). Restore it from a backup; refusing to start an empty one.`);
		return parsed;
	};
	const attempts = () => readLines<Attempt>(files.attempts, isAttempt);
	const unverified = () => readLines<UnverifiedNote>(files.unverified, isUnverifiedNote);
	return {
		files,
		options() {
			try {
				const raw = JSON.parse(fs.readFileSync(files.options, "utf-8")) as Partial<MathOptions>;
				return { ...DEFAULT_MATH_OPTIONS, ...(typeof raw.implicitCredit === "boolean" ? { implicitCredit: raw.implicitCredit } : {}) };
			} catch { return { ...DEFAULT_MATH_OPTIONS }; }
		},
		saveOptions(next) {
			fs.mkdirSync(dir, { recursive: true });
			writeFileAtomicSync(files.options, JSON.stringify({ implicitCredit: next.implicitCredit === true }, null, "\t"));
		},
		graph,
		saveGraph(next) {
			fs.mkdirSync(dir, { recursive: true });
			writeFileAtomicSync(files.concepts, JSON.stringify(next, null, "\t"));
		},
		attempts,
		appendAttempt(attempt) {
			if (!isAttempt(attempt)) throw new Error(`Refusing to log an invalid attempt (${(attempt as { id?: string }).id}).`);
			fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(files.attempts, `${JSON.stringify(attempt)}\n`, "utf-8");
		},
		unverified,
		rewriteConcept(from, into) {
			let changed = 0;
			const rows = attempts().map((a) => (a.conceptId === from ? (changed++, { ...a, conceptId: into }) : a));
			if (changed) writeLines(files.attempts, rows);
			const notes = unverified();
			if (notes.some((n) => n.conceptId === from)) writeLines(files.unverified, notes.map((n) => (n.conceptId === from ? { ...n, conceptId: into } : n)));
			return changed;
		},
		removeChat(chatId, stillReferenced = new Set()) {
			const rows = attempts();
			const kept = rows.filter((a) => a.chatId !== chatId);
			if (kept.length !== rows.length) writeLines(files.attempts, kept);
			const notes = unverified();
			const keptNotes = notes.filter((n) => n.chatId !== chatId);
			if (keptNotes.length !== notes.length) writeLines(files.unverified, keptNotes);
			// Concepts that chat created and nothing else touches go too.
			const g = graph();
			const used = new Set([...kept.map((a) => a.conceptId), ...keptNotes.map((n) => n.conceptId)]);
			const orphans = Object.values(g.concepts).filter((c) => c.createdIn === chatId && !used.has(c.id) && !stillReferenced.has(c.id) && !g.edges.some((e) => e.addedIn !== chatId && (e.from === c.id || e.to === c.id)));
			if (orphans.length || g.edges.some((e) => e.addedIn === chatId)) {
				const gone = new Set(orphans.map((c) => c.id));
				const concepts = Object.fromEntries(Object.entries(g.concepts).filter(([id]) => !gone.has(id)));
				const edges = g.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
				if (gone.size || edges.length !== g.edges.length) writeFileAtomicSync(files.concepts, JSON.stringify({ ...g, concepts, edges }, null, "\t"));
			}
			return rows.length - kept.length;
		},
		logMerge(entry) {
			fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(files.merges, `${JSON.stringify(entry)}\n`, "utf-8");
		},
	};
}

export const mathStore = createMathStore(MATH_DIR);
