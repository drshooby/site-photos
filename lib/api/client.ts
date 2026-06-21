import { env } from "@/lib/env";
import { getIdToken } from "@/lib/auth/session";
import type { PhotosResponse } from "./types";

async function authHeaders(): Promise<Headers> {
  const h = new Headers();
  const token = await getIdToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

export async function listPublicPhotos(): Promise<PhotosResponse> {
  if (process.env.NODE_ENV === "development") {
    const { listMockPhotos } = await import("./mock");
    return listMockPhotos();
  }
  const res = await fetch(`${env.apiGatewayUrl}/photos`, { cache: "no-store" });
  if (!res.ok) return { photos: [] };
  return res.json();
}

export async function listPrivatePhotos(): Promise<PhotosResponse | { forbidden: true }> {
  const headers = await authHeaders();
  if (!headers.has("Authorization")) return { forbidden: true };

  const res = await fetch(`${env.apiGatewayUrl}/photos/private`, {
    headers,
    cache: "no-store",
  });
  if (res.status === 403 || res.status === 401) return { forbidden: true };
  if (!res.ok) return { photos: [] };
  return res.json();
}

export async function adminPresign(body: {
  filename: string;
  contentType: string;
  title: string;
  isPublic: boolean;
}) {
  const headers = await authHeaders();
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${env.apiGatewayUrl}/admin/presign`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`presign failed: ${res.status}`);
  return res.json();
}

export async function adminDelete(photoId: string) {
  const headers = await authHeaders();
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${env.apiGatewayUrl}/admin/photo`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ photoId }),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
  return res.json();
}
