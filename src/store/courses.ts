/**
 * CourseStore — the fs JSON adapter (one file per course in data/courses/).
 * Implements core/course.ts CourseStore (docs/course-plans-plan.md §3).
 * Same idioms as the chat store: sync fs, id-guarded filenames, atomic
 * writes, tab-indented JSON. Unreadable or foreign files are skipped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { COURSE_ID_PATTERN, isCourseRecord, type CourseRecord, type CourseStore } from "../core/course.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export function createCourseStore(dir: string): CourseStore {
	const file = (id: string) => {
		if (!COURSE_ID_PATTERN.test(id)) throw new Error(`Invalid course id: ${id}`);
		return path.join(/* turbopackIgnore: true */ dir, `${id}.json`);
	};
	const read = (target: string): CourseRecord | null => {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ target, "utf-8"));
			return isCourseRecord(parsed) ? parsed : null;
		} catch { return null; }
	};
	return {
		list() {
			let names: string[];
			try { names = fs.readdirSync(/* turbopackIgnore: true */ dir); }
			catch { return []; }
			return names
				.filter((name) => name.endsWith(".json") && COURSE_ID_PATTERN.test(name.slice(0, -5)))
				.map((name) => read(path.join(/* turbopackIgnore: true */ dir, name)))
				.filter((course): course is CourseRecord => course !== null)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		get(id) {
			if (!COURSE_ID_PATTERN.test(id)) return null;
			return read(file(id));
		},
		save(course) {
			fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
			writeFileAtomicSync(file(course.id), JSON.stringify(course, null, "\t"), { allowInPlaceFallback: true });
			// Courses group sidebar rows, so a write is a list-shape change.
			emit("chats-changed", {});
		},
		delete(id) {
			try { fs.unlinkSync(file(id)); emit("chats-changed", {}); return true; }
			catch { return false; }
		},
	};
}

export const COURSES_DIR = path.join(/* turbopackIgnore: true */ PATHS.data, "courses");
export const courseStore = createCourseStore(COURSES_DIR);
