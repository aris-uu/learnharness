/**
 * Memory metrics for tools/lh-analysis (consolidation plan C7), read only:
 *
 *   npx tsx scripts/memory-metrics.ts [--data-dir <dir>]   → JSON on stdout
 *
 * For each schedule-moving event, the concept's stage just BEFORE it
 * (learning / mature / relearning), so pass rates are by stage at the time
 * of the attempt; time from a concept's first attempt to maturity; and the
 * lapse rate of mature concepts (an Again on a mature concept).
 */
import path from "node:path";
import { createMathStore } from "../src/store/math.ts";
import { conceptEvents, MATURE_STABILITY_DAYS } from "../src/core/memory/items.ts";
import { daysTo90, rateFsrs, type FsrsState } from "../src/core/memory/fsrs.ts";

const args = process.argv.slice(2);
const i = args.indexOf("--data-dir");
const dir = path.resolve(i >= 0 ? args[i + 1]! : path.join(process.env.APPDATA ?? "", "LearnHarness", "data"));
const store = createMathStore(path.join(dir, "math"));
const attempts = store.attempts();
const graph = store.graph();
const DAY = 86_400_000;

type Stage = "learning" | "mature" | "relearning";
const byStage: Record<Stage, { n: number; passed: number; again: number }> = { learning: { n: 0, passed: 0, again: 0 }, mature: { n: 0, passed: 0, again: 0 }, relearning: { n: 0, passed: 0, again: 0 } };
const toMaturity: number[] = [];
let matureConcepts = 0, lapsed = 0;
const bySource: Record<string, { n: number; passed: number }> = {};

const ids = [...new Set(attempts.map((a) => a.conceptId))];
for (const id of ids) {
	const own = attempts.filter((a) => a.conceptId === id && !a.implicit);
	const { events } = conceptEvents(id, own);
	let state: FsrsState | null = null;
	let everMature = false, lapsedHere = false;
	const first = Math.min(...own.map((a) => Date.parse(a.at)));
	for (const e of events) {
		if (e.kind !== "seed" && e.kind !== "review") continue;
		const at = Date.parse(e.at);
		if (e.kind === "review" && state) {
			const stage: Stage = daysTo90(state) >= MATURE_STABILITY_DAYS ? "mature" : everMature ? "relearning" : "learning";
			const b = byStage[stage];
			b.n++; if (e.rating >= 2) b.passed++; if (e.rating === 1) b.again++;
			if (stage === "mature" && e.rating === 1) lapsedHere = true;
			const src = own.find((a) => a.id === e.attemptId)?.source ?? "unknown";
			const s = bySource[src] ?? (bySource[src] = { n: 0, passed: 0 });
			s.n++; if (e.rating >= 2) s.passed++;
		}
		state = rateFsrs(state, e.rating, at);
		if (!everMature && daysTo90(state) >= MATURE_STABILITY_DAYS) { everMature = true; toMaturity.push((at - first) / DAY); }
	}
	if (everMature) { matureConcepts++; if (lapsedHere) lapsed++; }
}
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
console.log(JSON.stringify({
	dataDir: dir,
	concepts: Object.keys(graph.concepts).length,
	conceptsWithAttempts: ids.length,
	reviewsByStage: byStage,
	reviewsBySource: bySource,
	maturity: { threshold: MATURE_STABILITY_DAYS, matured: toMaturity.length, medianDaysToMaturity: median(toMaturity) },
	lapses: { matureConcepts, lapsed },
}, null, 1));
