import { NextResponse } from "next/server";
import { listPrivatePhotos } from "@/lib/api/client";

export async function GET() {
  const r = await listPrivatePhotos();
  if ("forbidden" in r) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(r);
}
