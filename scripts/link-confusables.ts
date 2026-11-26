/**
 * One-off backfill (docs/depth-and-contrast-plan.md B4): link the look-alike
 * pairs found in the 2026-11-26 analysis, so consolidation studies them
 * together and asks a contrast question.
 *
 *   npx tsx scripts/link-confusables.ts [--data-dir <dir>]           → dry run: prints what would change
 *   npx tsx scripts/link-confusables.ts [--data-dir <dir>] --apply   → backs up concepts.json, then writes
 *
 * Only math/concepts.json changes; the attempt log is never touched. Pairs
 * whose concepts are missing are reported and skipped. Re-running is a no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { createMathStore } from "../src/store/math.ts";
import { confusablesOf, linkConfusable, type Concept } from "../src/core/math-concepts.ts";

const args = process.argv.slice(2);
const i = args.indexOf("--data-dir");
const dir = path.resolve(i >= 0 ? args[i + 1]! : path.join(process.env.APPDATA ?? "", "LearnHarness", "data"));
const apply = args.includes("--apply");
const store = createMathStore(path.join(dir, "math"));

/** A look-alike that was not a concept yet: the determinant form, read for B_M (Review 2026-11-18). */
const NEW_CONCEPTS: Concept[] = [{
	id: "determinant-form",
	title: "The determinant form on R²",
	kind: "definition",
	statement: "B(x,y) = x₁y₂ − x₂y₁ = det[x y]: an antisymmetric bilinear form on R², with matrix [[0,1],[−1,0]] in the standard basis; it measures signed area, not length or angle.",
	createdAt: new Date().toISOString(),
	createdIn: "backfill-2026-11-26",
	status: "active",
}];

/** [concept, look-alike, evidence] from reports/learnharness-analysis-2026-11-26.md §4.4. */
const PAIRS: Array<[string, string, string]> = [
	["flux-integral-orientation", "surface-area-element", "Review 11-18: wrote |r_u×r_v| for the flux integral"],
	["divergence-theorem-r3", "flux-integral-orientation", "Review 11-19: gave the flux formula for the divergence theorem at 90%"],
	["box-flux-ftc", "divergence-theorem-r3", "Consolidate 11-21: P at the same point on both faces"],
	["new-basis-matrix", "matrix-change-basis", "bilinear 11-18: read a form's matrix diag(2,2) as a linear map at 90%"],
	["congruence", "matrix-change-basis", "bilinear 11-18: PᵀMP (forms) against P⁻¹AP (maps)"],
	["change-of-basis", "change-of-basis-coords", "spherical 11-19: [Au_j]_B called the jth column of A at 100%"],
	["form-preserver-equation", "determinant-form", "Review 11-18: read B_M as the determinant form"],
];

let graph = store.graph();
const changes: string[] = [];
for (const c of NEW_CONCEPTS) {
	if (graph.concepts[c.id]) continue;
	graph = { ...graph, concepts: { ...graph.concepts, [c.id]: c } };
	changes.push(`create ${c.id}: ${c.title}`);
}
for (const [a, b, why] of PAIRS) {
	const missing = [a, b].filter((id) => !graph.concepts[id]);
	if (missing.length) { console.log(`skip ${a} ↔ ${b}: no concept ${missing.join(", ")}`); continue; }
	if (confusablesOf(graph, a).includes(b)) { console.log(`already linked: ${a} ↔ ${b}`); continue; }
	graph = linkConfusable(graph, a, b);
	changes.push(`link ${a} ↔ ${b}  (${why})`);
}

console.log(changes.length ? changes.map((c) => `${apply ? "" : "would "}${c}`).join("\n") : "Nothing to change.");
if (apply && changes.length) {
	const backup = `${store.files.concepts}.bak-${new Date().toISOString().slice(0, 10)}`;
	fs.copyFileSync(store.files.concepts, backup);
	store.saveGraph(graph);
	console.log(`Wrote ${store.files.concepts} (backup: ${backup}).`);
} else if (!apply && changes.length) {
	console.log("Dry run. Pass --apply to write (concepts.json is backed up first).");
}
