import { CourseList } from "@/components/course-view";
import { listCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/** Every course (docs/course-plans-plan.md §7). */
export default function CoursesPage() {
	return (
		<div className="h-full overflow-y-auto">
			<CourseList courses={listCourses()} />
		</div>
	);
}
