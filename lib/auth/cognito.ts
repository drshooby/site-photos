import { env } from "@/lib/env";

type TokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: "Bearer";
};

export async function exchangeAuthCode(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.cognitoClientId,
    code,
    redirect_uri: env.cognitoRedirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch(`https://${env.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function refreshIdToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.cognitoClientId,
    refresh_token: refreshToken,
  });

  const res = await fetch(`https://${env.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`refresh failed: ${res.status}`);
  }
  return res.json();
}

export function loginUrl(state: string, challenge: string): string {
  const u = new URL(`https://${env.cognitoDomain}/oauth2/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.cognitoClientId);
  u.searchParams.set("redirect_uri", env.cognitoRedirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("identity_provider", "Google");
  return u.toString();
}

export function logoutUrl(): string {
  const u = new URL(`https://${env.cognitoDomain}/logout`);
  u.searchParams.set("client_id", env.cognitoClientId);
  u.searchParams.set("logout_uri", env.cognitoLogoutUri);
  return u.toString();
}
