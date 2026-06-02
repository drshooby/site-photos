import { NextResponse } from "next/server";
import { logoutUrl } from "@/lib/auth/cognito";

export async function GET() {
  const res = NextResponse.redirect(logoutUrl());
  res.cookies.set("id_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("refresh_token", "", { path: "/auth/refresh", maxAge: 0 });
  return res;
}
