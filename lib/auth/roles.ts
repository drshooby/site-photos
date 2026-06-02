import { env } from "@/lib/env";
import { getIdToken } from "./session";

// Checks admin role by calling the admin Lambda's GET /admin/me route.
// 403 → viewer (authenticated but not whitelisted as admin).
// 200 → role from body.
// Anything else → null (treated as unauthenticated downstream).

export async function getCurrentRole(): Promise<"admin" | "viewer" | null> {
  const token = await getIdToken();
  if (!token) return null;

  const res = await fetch(`${env.apiGatewayUrl}/admin/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 403) return "viewer";
  if (!res.ok) return null;
  const body = await res.json();
  return body.role ?? null;
}
