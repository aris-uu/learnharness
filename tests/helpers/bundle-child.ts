/**
 * Bundle a TypeScript child-process entry once, so tests that spawn it many
 * times run plain JavaScript instead of paying tsx's per-process transform of
 * the whole import graph (about 2.7 s a spawn on Windows, far more under suite
 * load; bundled: about 0.5 s). npm packages are bundled too, since resolving
 * them is most of what is left; native addons and builtins stay external, so a
 * child's patches of the shared `fs`/`process` objects behave as under tsx.
 * Each source module keeps its own import.meta.url/dirname/filename (config.ts
 * derives the repo root from it), rewritten to the original file's location.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

/** Pin import.meta in every bundled source file to that file's own path. */
const sourceMeta: Plugin = {
	name: "source-import-meta",
	setup(pluginBuild) {
		pluginBuild.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
			if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
			const text = fs.readFileSync(args.path, "utf8");
			if (!text.includes("import.meta")) return undefined;
			const contents = text
				.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(args.path).href))
				.replaceAll("import.meta.dirname", JSON.stringify(path.dirname(args.path)))
				.replaceAll("import.meta.filename", JSON.stringify(args.path));
			const ext = path.extname(args.path).slice(1).replace(/^[cm]/, "");
			return { contents, loader: ext as "ts" | "tsx" | "js" | "jsx" };
		});
	},
};

/** Packages that load a .node addon: never bundled. */
const NATIVE_PACKAGES = ["@napi-rs/canvas", "@resvg/resvg-js", "*.node"];

const built = new Map<string, Promise<string>>();
const repo = path.resolve(import.meta.dirname, "..", "..");

/** The path of a bundled .mjs for `entry` (repo-relative or absolute), built on first use and removed at exit. */
export function bundleChild(entry: string): Promise<string> {
	const absolute = path.resolve(repo, entry);
	const cached = built.get(absolute);
	if (cached) return cached;
	const pending = buildChild(absolute);
	built.set(absolute, pending);
	return pending;
}

async function buildChild(absolute: string): Promise<string> {
	// Inside the repo, so the external native packages resolve from node_modules.
	const cache = path.join(repo, "node_modules", ".cache", "lh-test-children");
	fs.mkdirSync(cache, { recursive: true });
	const dir = fs.mkdtempSync(path.join(cache, "child-"));
	process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	const outfile = path.join(dir, `${path.basename(absolute).replace(/\.[cm]?tsx?$/, "")}.mjs`);
	await build({
		entryPoints: [absolute],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: NATIVE_PACKAGES,
		tsconfig: path.join(repo, "tsconfig.json"),
		logLevel: "error",
		plugins: [sourceMeta],
		// Bundled CommonJS (electron/*.cjs) calls require(); give the ESM bundle a real one.
		banner: { js: `import { createRequire as __lhCreateRequire } from "node:module"; const require = __lhCreateRequire(${JSON.stringify(pathToFileURL(absolute).href)});` },
	});
	return outfile;
}
