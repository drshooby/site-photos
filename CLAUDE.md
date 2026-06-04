# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For a full project overview, read [`README.md`](./README.md). For deploy / teardown, read [`DEPLOY.md`](./DEPLOY.md). Both are kept current; use them as the source of truth before editing CLAUDE.md.

## Next.js version warning

This is Next.js 16 + React 19 (App Router). Breaking changes vs. older versions: APIs, conventions, and file structure may differ from your training data. Read `node_modules/next/dist/docs/` for the relevant area before writing new code. Heed deprecation notices.

Specific traps this repo has already hit (full write-up in `DEPLOY.md` §12 "Critical landmines"):

- **Auth-route links must be plain `<a href>`, not `<Link>`.** A `<Link>` triggers an RSC fetch (`?_rsc=` query), so the PKCE `state` cookie lands on the discarded fetch response — never on the document — and `/auth/callback` blows up with `invalid_state`. Fix shipped in commit `0763929`; do not reintroduce `<Link>` for `/auth/*`.
- **`refresh_token` cookie must be path `/`.** Narrowing it (e.g. to `/auth/refresh`) breaks middleware refresh on `/admin/*` and forces re-login. Fix is in `app/auth/callback/route.ts` and `proxy.ts`.
- **`cookies()` is async** in this version — `await cookies()` everywhere (see `lib/auth/session.ts`).

## Commands

```bash
bun dev          # dev server on localhost:3000
bun build        # production build
bun lint         # eslint
```

Infra (from `infra/aws/`):

```bash
terraform init
terraform plan
terraform apply
terraform destroy
```

Convenience wrappers: `scripts/deploy.sh`, `scripts/teardown.sh`.

## Architecture overview

`photos.davidshubov.com` — Next.js 16 portfolio photo site on Vercel, backed by AWS, with Cloudflare for DNS. Full layout in `README.md` under "Repository layout"; only deltas worth highlighting here.

### Frontend (`app/`)

- App Router, React 19, TypeScript.
- Auth: Cognito hosted UI federating to Google (PKCE). `id_token` + `refresh_token` are stored in httpOnly cookies set by `app/auth/callback/route.ts`. **Do not** introduce `react-oidc-context` or any client-side token storage.
- The token forwarded to API Gateway is `id_token` (the Cognito authorizer is configured for ID tokens, not access tokens).
- `proxy.ts` is the edge middleware: guards `/admin/*` and refreshes `id_token` when it's within 60s of expiry. The matcher excludes `_next/static`, `_next/image`, and `favicon.ico`.
- `lib/auth/session.ts` reads cookies + decodes JWT claims (unverified — API Gateway is the one that actually verifies).
- `lib/api/client.ts` is the server-side fetch wrapper; it adds `Authorization: Bearer <id_token>` when a cookie is present.
- Browser-facing routes under `app/api/admin/*` are same-origin proxies — they forward Bearer to API Gateway so the browser never sees the JWT directly.
- `next/image` with `images.remotePatterns` pinned to `cdn.photos.davidshubov.com`.

### AWS infrastructure (`infra/aws/`)

Single Terraform workspace, region `us-east-1`. Files are split by service: `s3.tf`, `cloudfront.tf`, `acm.tf`, `cognito.tf`, `api_gateway.tf`, `lambdas.tf`, `iam.tf`, `dynamodb.tf`. Variables and outputs in `variables.tf` / `outputs.tf`.

- **S3** — single bucket, two prefixes: `originals/` (private, S3 ObjectCreated → resize Lambda) and `processed/` (CloudFront OAC only).
- **CloudFront** — OAC origin on `processed/`. Long TTL on image objects.
- **DynamoDB** — `photos` (PK `photo_id`, GSI on `is_public + created_at`) and `users` (PK `email`, attr `role`). `users` is seeded with `admin_email` as `admin`.
- **API Gateway** REST API. Routes:
  - `GET /photos` — no auth, public only.
  - `GET /photos/private` — Cognito authorizer + Lambda-side allowlist check.
  - `POST /admin/presign` — Cognito + admin role.
  - `DELETE /admin/photo` — Cognito + admin role.
  - `GET /admin/me` — Cognito; returns current role or 403 if not in `users`.
- **Lambdas** (Python 3.12): `list_photos`, `admin` (presign + delete + me), `resize` (S3 ObjectCreated trigger on `originals/`, uses Klayers Pillow layer).

## Environment variables

**Next.js (`.env.local` / Vercel project):**

```
COGNITO_DOMAIN
COGNITO_CLIENT_ID
COGNITO_REDIRECT_URI=https://photos.davidshubov.com/auth/callback
COGNITO_LOGOUT_URI=https://photos.davidshubov.com
API_GATEWAY_URL
CLOUDFRONT_URL
```

`lib/env.ts` throws at import time if any of these are missing.

**Lambda (set via Terraform):** `PHOTOS_TABLE`, `USERS_TABLE`, `CLOUDFRONT_DOMAIN`, `BUCKET_NAME`.

**Terraform (`infra/aws/terraform.tfvars`, gitignored):** `google_auth_client_id`, `google_auth_client_secret`, `pillow_layer_arn`. See `DEPLOY.md` §2.

## Component structure

Each component lives in its own folder under `components/`:

```
components/
└── MyComponent/
    ├── index.tsx          # re-export only: export { MyComponent } from "./MyComponent"
    ├── MyComponent.tsx    # implementation
    ├── MyComponent.module.css
    └── MyComponent.types.ts   # (if the component has non-trivial props/types)
```

`index.tsx` is a pure barrel re-export — no logic. Types file is optional; add it when prop types are non-trivial or shared.

## Key constraints

- Originals (`originals/` prefix) must never be accessible via CloudFront or public S3.
- Resize Lambda strips all EXIF; only `ImageDescription` (mapped to `title`) is preserved into DynamoDB.
- Presigned upload uses POST policy (not PUT) targeting `originals/{photo_id}/{filename}`, with `x-amz-meta-is-public` as a required form field.
- `is_public` defaults to `false` on upload; the admin UI sends it explicitly.
- No CloudFront invalidation on delete — see `README.md` "Operational notes" if you need to add it.
- No pagination — `list_photos` caps at 60 photos.

## When in doubt

- `README.md` — what the system does and how it's wired.
- `DEPLOY.md` — how to bring it up, the CAA/ACM gotchas, and a "Common errors" table.
- `docs/superpowers/specs/2026-06-02-photo-subdomain-design.md` and `docs/superpowers/plans/2026-06-02-photo-subdomain.md` — historical design + plan, useful for *why* decisions were made.
