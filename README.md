# photos.davidshubov.com

A photography portfolio at `photos.davidshubov.com`. Next.js 16 on Vercel, AWS for storage / auth / image pipeline, Cloudflare for DNS. Doubles as an intentional infra learning project.

For the step-by-step bring-up / teardown, see [`DEPLOY.md`](./DEPLOY.md). For agent-facing conventions, see [`CLAUDE.md`](./CLAUDE.md).

---

## What this does

- Public visitors see a grid of photos flagged `is_public = true`.
- Signed-in users on the `users` allowlist (role `viewer` or `admin`) additionally see private photos.
- A signed-in `admin` sees `/admin`, which uploads new photos via S3 presigned POST and can delete any photo.
- Uploads are EXIF-stripped, resized to three web sizes, and served from CloudFront. Originals are never exposed.

## Stack

| Layer            | Choice                                                          |
| ---------------- | --------------------------------------------------------------- |
| Frontend         | Next.js 16 (App Router) + React 19 + TypeScript, deployed on Vercel |
| Image gallery    | `react-photo-album` + `next/image`                              |
| Auth             | AWS Cognito User Pool federating to Google OAuth (PKCE flow)    |
| Session          | httpOnly cookies (`id_token`, `refresh_token`) set by Next routes |
| API              | API Gateway (REST) + 3 Python 3.12 Lambdas                      |
| Storage          | S3 (single bucket, two prefixes) + DynamoDB (2 tables)          |
| CDN              | CloudFront with Origin Access Control on the S3 bucket          |
| TLS              | ACM (us-east-1) for `cdn.photos.davidshubov.com`                |
| DNS              | Cloudflare (DNS-only / grey-cloud for every record)             |
| IaC              | Terraform (`infra/aws/`)                                        |

---

## Repository layout

```
app/                         Next.js App Router
  page.tsx                   Public + private photo grid (Server Component)
  layout.tsx                 Root layout, mounts <SiteHeader/>
  admin/                     /admin page — admin-only upload + delete UI
  auth/
    login/route.ts           Starts Cognito hosted-UI PKCE flow (sets state + verifier cookies)
    callback/route.ts        Exchanges code for tokens, sets id_token + refresh_token cookies
    logout/route.ts          Clears cookies, redirects to Cognito /logout
    refresh/route.ts         Server-triggered refresh using refresh_token cookie
  api/admin/                 Same-origin proxy endpoints for the browser → API Gateway
    presign/route.ts
    photo/route.ts           DELETE
    photos/route.ts          GET (admin listing)

components/                  One folder per component (see CLAUDE.md for layout)
  SiteHeader/                Sign-in / sign-out / current email + role
  PhotoGrid/                 react-photo-album wrapper with next/image
  AdminUpload/               Drag-drop → presigned POST → S3
  AdminPhotoList/            Admin view + delete

lib/
  env.ts                     Validates required env vars at import time
  api/client.ts              Server-side fetch to API Gateway with Bearer token
  api/types.ts               Photo + response types
  auth/cognito.ts            Hosted-UI URL builders + token exchange / refresh
  auth/session.ts            Cookie reads + unverified JWT claims decode
  auth/pkce.ts               PKCE state/verifier/challenge helpers
  auth/roles.ts              Calls GET /admin/me to resolve current user role

proxy.ts                     Edge middleware: guards /admin/*, auto-refreshes id_token
next.config.ts               images.remotePatterns = cdn.photos.davidshubov.com
.env.local.example           Required env vars for local dev

infra/aws/                   Terraform — single workspace, us-east-1
  main.tf                    Provider + default tags
  variables.tf outputs.tf
  s3.tf                      Bucket, OAC policy, S3 → Lambda event notification
  cloudfront.tf              Distribution, OAC, cache behaviors, alias to cdn_domain
  acm.tf                     us-east-1 cert + DNS validation outputs
  cognito.tf                 User pool, Google IdP, hosted-UI domain, app client
  api_gateway.tf             REST API, Cognito authorizer, all routes (see below)
  lambdas.tf                 Three function definitions + Pillow layer wiring
  iam.tf                     Lambda execution roles + scoped S3 / DynamoDB policies
  dynamodb.tf                photos + users tables, seeds admin_email as admin
  lambda/
    list_photos/main.py      GET /photos and GET /photos/private
    admin/main.py            POST /admin/presign, DELETE /admin/photo, GET /admin/me
    resize/main.py           S3 ObjectCreated trigger; Pillow resize + EXIF strip

scripts/
  deploy.sh                  Convenience wrapper around terraform apply
  teardown.sh                Convenience wrapper around terraform destroy
  reconcile.py               Manual S3 ↔ DynamoDB drift check

docs/superpowers/            Design spec + implementation plan history

radiant/                     (Not in this repo — referenced by CLAUDE.md as legacy patterns. If present, do not modify.)
```

---

## Request flow

### Anonymous viewer

1. Browser hits Vercel → `app/page.tsx` runs server-side.
2. `listPublicPhotos()` calls `GET /photos` (no auth).
3. `listPrivatePhotos()` short-circuits (no `id_token` cookie) and returns `{ forbidden: true }`.
4. `<PhotoGrid>` renders public-only photos through `next/image` from `cdn.photos.davidshubov.com`.

### Signed-in viewer / admin

1. Click **Sign in** → `<a href="/auth/login">` (plain anchor — never `<Link>`, see `DEPLOY.md` §10).
2. `/auth/login` generates PKCE `state` + `code_verifier`, sets them as short-lived httpOnly cookies, redirects to Cognito hosted UI with `identity_provider=Google`.
3. Google → Cognito → redirect to `/auth/callback?code=...&state=...`.
4. `callback/route.ts` verifies state, exchanges the code (`exchangeAuthCode`), sets `id_token` (TTL = JWT exp) and `refresh_token` (path `/`, 30d) cookies, redirects home.
5. Subsequent Server Component renders read `id_token` from cookies and forward it as `Authorization: Bearer …` to API Gateway.
6. Edge middleware `proxy.ts` runs on every request: if `id_token` expires within 60s, it calls `refreshIdToken()` and rewrites the cookie. If refresh fails, both cookies are cleared.
7. `/admin/*` requests with no token are 302'd to `/auth/login` from `proxy.ts`.

### Upload

1. Admin drops a file in `AdminUpload`.
2. Browser → `app/api/admin/presign` (same-origin Next route) → forwards Bearer token to `POST /admin/presign`.
3. Admin Lambda checks `users[email].role == admin`, writes a `photos` row with `is_public` from request body, returns a presigned POST policy targeting `originals/{photo_id}/{filename}` with `x-amz-meta-is-public` as a required field.
4. Browser POSTs the file directly to S3.
5. S3 `ObjectCreated` event on `originals/` triggers the `resize` Lambda.
6. `resize` strips EXIF (keeps `ImageDescription` as `title`), generates `thumb`/`medium`/`large` JPEGs into `processed/{photo_id}/`, and updates the `photos` row with dimensions + URLs.
7. CloudFront serves `processed/*` via OAC — the bucket itself is fully private.

### Delete

1. `AdminPhotoList` → `DELETE /api/admin/photo` → `DELETE /admin/photo`.
2. Admin Lambda deletes all `originals/{photo_id}/*` and `processed/{photo_id}/*` objects, then the DynamoDB row.
3. CloudFront cache is *not* explicitly invalidated; deletion relies on the cache eventually expiring and on the deleted `photo_id` no longer appearing in listings.

---

## API surface

All routes live under the API Gateway invoke URL (`API_GATEWAY_URL`). Authenticated routes use the Cognito authorizer; admin routes additionally check role inside the Lambda.

| Method   | Route             | Auth                  | Lambda        | Description                                                  |
| -------- | ----------------- | --------------------- | ------------- | ------------------------------------------------------------ |
| `GET`    | `/photos`         | None                  | `list_photos` | Returns photos where `is_public = true`.                     |
| `GET`    | `/photos/private` | Cognito + allowlist   | `list_photos` | Returns all photos (public + private) if caller is in `users`. 403 otherwise. |
| `POST`   | `/admin/presign`  | Cognito + admin role  | `admin`       | Returns presigned POST fields for `originals/{photo_id}/…`.  |
| `DELETE` | `/admin/photo`    | Cognito + admin role  | `admin`       | Removes S3 objects + DynamoDB row for `photoId`.             |
| `GET`    | `/admin/me`       | Cognito               | `admin`       | Returns `{ role: "admin" \| "viewer" }`; 403 if not in `users`. |

Same-origin proxy routes (`app/api/admin/*`) just forward the browser's cookie-derived Bearer token to the corresponding API Gateway route so the browser never sees the Cognito JWT.

---

## Data model

### DynamoDB `photos`

| Attribute    | Type   | Notes                                                  |
| ------------ | ------ | ------------------------------------------------------ |
| `photo_id`   | string | PK. UUID assigned at presign time.                     |
| `s3_key`     | string | `originals/{photo_id}/{filename}`                      |
| `is_public`  | bool   | Set from upload form; mirrored as `x-amz-meta-is-public`. |
| `title`      | string | Sourced from upload form, then overwritten by EXIF `ImageDescription` if present. |
| `created_at` | string | ISO 8601. Used for ordering.                           |
| `width`      | number | Set by resize Lambda. Old rows fall back to 1200.      |
| `height`     | number | Set by resize Lambda. Old rows fall back to 800.       |
| `urls`       | map    | `{ thumb, medium, large }` — CloudFront URLs.          |

GSI: `is_public + created_at` — backs the public listing.

### DynamoDB `users`

| Attribute | Type   | Notes                                            |
| --------- | ------ | ------------------------------------------------ |
| `email`   | string | PK. Matches the Cognito ID-token `email` claim.  |
| `role`    | string | `admin` or `viewer`. Seeded once with `admin_email` from `terraform.tfvars`. |

There is no self-serve invite flow — to add a viewer, add a row to `users` directly (Console, CLI, or extend `dynamodb.tf`).

### S3

- `s3://<bucket>/originals/{photo_id}/{filename}` — private, no public ACL, no CloudFront route. S3 → Lambda event trigger only.
- `s3://<bucket>/processed/{photo_id}/{size}.jpg` — served exclusively via CloudFront OAC.

---

## Environment

### Next.js (`.env.local` locally, Vercel project env vars in prod)

```
COGNITO_DOMAIN              # e.g. photos-xxxx.auth.us-east-1.amazoncognito.com
COGNITO_CLIENT_ID
COGNITO_REDIRECT_URI        # https://photos.davidshubov.com/auth/callback
COGNITO_LOGOUT_URI          # https://photos.davidshubov.com
API_GATEWAY_URL             # https://xxxx.execute-api.us-east-1.amazonaws.com/prod
CLOUDFRONT_URL              # https://cdn.photos.davidshubov.com
```

Missing values throw at module load (`lib/env.ts`) — fail fast over silent misconfig.

### Lambda (set by Terraform)

`PHOTOS_TABLE`, `USERS_TABLE`, `CLOUDFRONT_DOMAIN`, `BUCKET_NAME`.

### Terraform (`infra/aws/terraform.tfvars`, gitignored)

```hcl
google_auth_client_id     = "..."
google_auth_client_secret = "..."
pillow_layer_arn          = "..."   # see DEPLOY.md §2
```

---

## Local development

```bash
bun install
cp .env.local.example .env.local   # fill in from `terraform output`
bun dev                            # http://localhost:3000
bun lint
bun build
```

Local sign-in works because `callback_urls` / `logout_urls` in `infra/aws/variables.tf` include `http://localhost:3000`.

---

## Operational notes

- **Bring-up requires at least two `terraform apply` runs.** Apply #1 creates everything except CloudFront (which fails on the unvalidated ACM cert). You then add the ACM validation CNAMEs in Cloudflare *by hand* — Terraform doesn't manage DNS here, so this step can't be automated away. Once ACM flips to `ISSUED`, apply #2 finishes CloudFront. `scripts/deploy.sh` is a thin wrapper around a single `terraform apply` and is expected to be re-run. See `DEPLOY.md` §3 for the full sequence.
- **Auth-route links MUST be plain `<a href>`, never `next/link` `<Link>`.** Fix shipped in commit `0763929`; full root-cause write-up in `DEPLOY.md` §12.
- **CloudFront cache invalidation on delete is not implemented.** A deleted photo disappears from listings immediately (DDB row gone), so the stale CDN object is no longer linked. If you need hard invalidation, add a `CreateInvalidation` call in the admin Lambda's delete path.
- **Pagination is not implemented.** `list_photos` returns the first 60 photos by `created_at` desc. Past 60 photos, add cursor support.
- **HEIC ingest is not supported.** Convert on the Mac before upload.
- **`scripts/reconcile.py`** is manual; run it if you suspect S3 ↔ DynamoDB drift.
- **Auth links must be plain `<a href>`, not `<Link>`** — see `DEPLOY.md` §10 (`invalid_state` row) for the RSC-fetch bug this avoids.

## Deliberately not built

HEIC ingest, cursor pagination, background S3 ↔ DDB reconciliation, manual photo ordering, multi-region failover, upload progress beyond an elapsed-seconds counter.

---

## Where to read more

- **Deploy / teardown:** [`DEPLOY.md`](./DEPLOY.md)
- **Agent conventions, Next.js gotchas:** [`CLAUDE.md`](./CLAUDE.md)
- **Original design spec:** [`docs/superpowers/specs/2026-06-02-photo-subdomain-design.md`](./docs/superpowers/specs/2026-06-02-photo-subdomain-design.md)
- **Implementation plan history:** [`docs/superpowers/plans/2026-06-02-photo-subdomain.md`](./docs/superpowers/plans/2026-06-02-photo-subdomain.md)
