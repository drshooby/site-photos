import { cookies } from "next/headers";

export type Claims = {
  email?: string;
  exp?: number;
  sub?: string;
  "cognito:username"?: string;
};

export function decodeJwtClaimsUnverified(token: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function getIdToken(): Promise<string | null> {
  const store = await cookies();
  return store.get("id_token")?.value ?? null;
}

export async function getRefreshToken(): Promise<string | null> {
  const store = await cookies();
  return store.get("refresh_token")?.value ?? null;
}

export async function getCurrentEmail(): Promise<string | null> {
  const token = await getIdToken();
  if (!token) return null;
  return decodeJwtClaimsUnverified(token)?.email ?? null;
}

export function isExpiringSoon(claims: Claims, withinSeconds = 60): boolean {
  if (!claims.exp) return true;
  return claims.exp - Math.floor(Date.now() / 1000) < withinSeconds;
}
