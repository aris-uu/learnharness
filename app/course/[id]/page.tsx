import { notFound } from "next/navigation";
import { CoursePage, type CoursePageView } from "@/components/course-view";
import { readCourseView } from "@/src/server";

export const dynamic = "force-dynamic";

/** One course: map, digest, sources, sittings (docs/course-plans-plan.md §7). */
export default async function CourseRoute({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = readCourseView(id);
	if (!view) notFound();
	return (
		<div className="h-full overflow-y-auto">
			<CoursePage key={id} initial={view as unknown as CoursePageView} />
		</div>
	);
}
