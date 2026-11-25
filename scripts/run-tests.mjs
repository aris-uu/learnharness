#!/usr/bin/env node
/**
 * The test suite runner (`npm test`).
 *
 *   node --import tsx scripts/run-tests.mjs                 every tests/*.test.ts(x)
 *   node --import tsx scripts/run-tests.mjs review memory   files whose name contains a word
 *
 * Same process isolation and parallelism as `tsx --test`, plus two things:
 * - Longest files first. A few files take most of a minute; started last,
 *   they alone set the suite's wall time. Each run saves every file's time to
 *   node_modules/.cache/lh-test-durations.json and the next run schedules from
 *   it (unknown files go first, then by size, as a guess).
 * - The file list goes to the runner API, not the command line, which is too
 *   long for Windows with every file spelled out.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

process.env.NODE_ENV = "test";
const repo = path.resolve(import.meta.dirname, "..");
const testsDir = path.join(repo, "tests");
const cacheFile = path.join(repo, "node_modules", ".cache", "lh-test-durations.json");

const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const all = fs.readdirSync(testsDir).filter((f) => /\.test\.tsx?$/.test(f)).map((f) => path.join(testsDir, f));
const files = filters.length ? all.filter((f) => filters.some((w) => path.basename(f).includes(w))) : all;
if (files.length === 0) {
	console.error(`no test file matches ${filters.join(", ")}`);
	process.exit(2);
}

/** @type {Record<string, number>} */
let known = {};
try { known = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* first run: guess by size */ }
const key = (file) => path.relative(repo, file).replaceAll("\\", "/");
const size = (file) => fs.statSync(file).size;
files.sort((a, b) => {
	const ka = known[key(a)], kb = known[key(b)];
	if (ka === undefined || kb === undefined) return ka === undefined && kb === undefined ? size(b) - size(a) : ka === undefined ? -1 : 1;
	return kb - ka;
});

const started = Date.now();
const stream = run({ files, concurrency: Math.max(1, os.availableParallelism() - 1), isolation: "process" });
/** @type {Record<string, number>} */
const durations = {};
let failed = false;
const record = (event) => {
	if (event.nesting === 0 && event.file) durations[key(event.file)] = (durations[key(event.file)] ?? 0) + (event.details?.duration_ms ?? 0);
};
stream.on("test:pass", record);
stream.on("test:fail", (event) => { record(event); failed = true; });
stream.compose(spec).pipe(process.stdout);
stream.on("end", () => {
	// Merge, so a filtered run keeps the other files' times.
	const merged = { ...known };
	for (const [file, ms] of Object.entries(durations)) merged[file] = Math.round(ms);
	try {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		fs.writeFileSync(cacheFile, JSON.stringify(merged, null, "\t"));
	} catch { /* timings are an optimization only */ }
	console.log(`ℹ wall ${((Date.now() - started) / 1000).toFixed(1)}s for ${files.length} files`);
	if (failed) process.exitCode = 1;
});
