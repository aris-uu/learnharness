import { MAX_PASTED_IMAGE_BYTES, pastedImageExtension, savePastedImage } from "@/src/server";

/** Stores a clipboard image so it can join a message as an ordinary file path. */
export async function POST(req: Request) {
	const declared = Number(req.headers.get("content-length") ?? 0);
	if (declared > MAX_PASTED_IMAGE_BYTES) return Response.json({ error: "Image is too large" }, { status: 413 });
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.length > MAX_PASTED_IMAGE_BYTES) return Response.json({ error: "Image is too large" }, { status: 413 });
	const extension = pastedImageExtension(bytes);
	if (!extension) return Response.json({ error: "Only PNG, JPEG, WebP or GIF images can be pasted" }, { status: 415 });
	return Response.json({ path: savePastedImage(bytes, extension) });
}
