import { NextRequest, NextResponse } from "next/server";
import { adminDelete } from "@/lib/api/client";

export async function DELETE(req: NextRequest) {
  const { photoId } = await req.json();
  try {
    return NextResponse.json(await adminDelete(photoId));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
