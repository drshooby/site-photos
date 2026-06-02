import { NextResponse } from "next/server";
import { codeChallenge, generateCodeVerifier, generateState } from "@/lib/auth/pkce";
import { loginUrl } from "@/lib/auth/cognito";

export async function GET() {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = codeChallenge(verifier);

  const res = NextResponse.redirect(loginUrl(state, challenge));
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/auth/callback",
    maxAge: 600,
  };
  res.cookies.set("oauth_state", state, cookieOpts);
  res.cookies.set("pkce_verifier", verifier, cookieOpts);
  return res;
}
