import { NextRequest, NextResponse } from "next/server";
import { decodeJwtClaimsUnverified } from "@/lib/auth/session";
import { refreshIdToken } from "@/lib/auth/cognito";

const PROTECTED_PREFIXES = ["/admin"];

function clearAuth(res: NextResponse) {
  res.cookies.set("id_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("refresh_token", "", { path: "/auth/refresh", maxAge: 0 });
}

async function ensureFreshToken(req: NextRequest): Promise<NextResponse | null> {
  const idToken = req.cookies.get("id_token")?.value;
  if (!idToken) return null;

  const claims = decodeJwtClaimsUnverified(idToken);
  const expiringSoon = !claims?.exp ||
    claims.exp - Math.floor(Date.now() / 1000) < 60;

  if (!expiringSoon) return null;

  const refresh = req.cookies.get("refresh_token")?.value;
  if (!refresh) {
    const res = NextResponse.next();
    clearAuth(res);
    return res;
  }

  try {
    const tokens = await refreshIdToken(refresh);
    const newClaims = decodeJwtClaimsUnverified(tokens.id_token);
    const maxAge = newClaims?.exp
      ? Math.max(0, newClaims.exp - Math.floor(Date.now() / 1000))
      : tokens.expires_in;
    const res = NextResponse.next({
      request: {
        headers: new Headers(req.headers),
      },
    });
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
    const res = NextResponse.next();
    clearAuth(res);
    return res;
  }
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(p => path.startsWith(p));

  const refreshed = await ensureFreshToken(req);

  const hasToken = !!(refreshed
    ? refreshed.cookies.get("id_token")?.value
    : req.cookies.get("id_token")?.value);

  if (isProtected && !hasToken) {
    return NextResponse.redirect(new URL("/auth/login", req.url));
  }

  return refreshed ?? NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
