import { NextRequest, NextResponse } from "next/server";
import { adminPresign } from "@/lib/api/client";

export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    return NextResponse.json(await adminPresign(body));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
