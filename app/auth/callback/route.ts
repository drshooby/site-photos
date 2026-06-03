import { NextRequest, NextResponse } from "next/server";
import { exchangeAuthCode } from "@/lib/auth/cognito";
import { decodeJwtClaimsUnverified } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const storedState = req.cookies.get("oauth_state")?.value;
  const verifier = req.cookies.get("pkce_verifier")?.value;

  if (!code || !state || !storedState || state !== storedState || !verifier) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  const tokens = await exchangeAuthCode(code, verifier);
  const claims = decodeJwtClaimsUnverified(tokens.id_token);
  const idMaxAge = claims?.exp
    ? Math.max(0, claims.exp - Math.floor(Date.now() / 1000))
    : tokens.expires_in;

  const res = NextResponse.redirect(new URL("/", req.url));

  res.cookies.set("id_token", tokens.id_token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: idMaxAge,
  });

  if (tokens.refresh_token) {
    res.cookies.set("refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  // Delete transient cookies — must repeat the original path or browsers ignore.
  const transient = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/auth",
    maxAge: 0,
  };
  res.cookies.set("oauth_state", "", transient);
  res.cookies.set("pkce_verifier", "", transient);

  return res;
}
