import { NextRequest, NextResponse } from "next/server";
import { refreshIdToken } from "@/lib/auth/cognito";
import { decodeJwtClaimsUnverified } from "@/lib/auth/session";

function clearCookies(res: NextResponse) {
  res.cookies.set("id_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("refresh_token", "", { path: "/auth/refresh", maxAge: 0 });
}

export async function POST(req: NextRequest) {
  const refresh = req.cookies.get("refresh_token")?.value;
  if (!refresh) {
    const res = NextResponse.json({ error: "no_refresh" }, { status: 401 });
    clearCookies(res);
    return res;
  }

  try {
    const tokens = await refreshIdToken(refresh);
    const claims = decodeJwtClaimsUnverified(tokens.id_token);
    const maxAge = claims?.exp
      ? Math.max(0, claims.exp - Math.floor(Date.now() / 1000))
      : tokens.expires_in;

    const res = new NextResponse(null, { status: 204 });
    res.cookies.set("id_token", tokens.id_token, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge,
    });
    if (tokens.refresh_token) {
      res.cookies.set("refresh_token", tokens.refresh_token, {
        httpOnly: true, secure: true, sameSite: "lax",
        path: "/auth/refresh", maxAge: 60 * 60 * 24 * 30,
      });
    }
    return res;
  } catch {
    const res = NextResponse.json({ error: "refresh_failed" }, { status: 401 });
    clearCookies(res);
    return res;
  }
}
