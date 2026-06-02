# Photo Subdomain — Design Spec

**Status:** Draft, pending user review
**Date:** 2026-06-02
**Supersedes the open questions in:** `GOAL.md`, `photo_subdomain_build_69d4eecc.plan.md`

This spec captures decisions made during the brainstorming pass. The base plan in `photo_subdomain_build_69d4eecc.plan.md` (architecture, repo layout, IAM split, S3 prefix model, DynamoDB schema, API Gateway path split) stands; this document records the resolutions to the gaps surfaced during review.

---

## Scope

Portfolio photo site at `photos.davidshubov.com`. Next.js 16 (App Router) on Vercel as UI + auth BFF. AWS backend: Cognito + Google IdP, API Gateway (REST) with Cognito authorizer, three Python 3.12 Lambdas, S3 single bucket with two prefixes, CloudFront OAC, DynamoDB for metadata and roles.

Three audiences:

- **Anonymous** — sees only `is_public = true` photos.
- **Whitelisted viewer** (signed in, in `users` table) — sees all photos.
- **Admin** — sees all photos plus `/admin` upload + delete UI.

All region-bound resources pin to **us-east-1**.

---

## Auth

### Identity

- Cognito User Pool, hosted UI, Google federated IdP only (no native Cognito passwords).
- Public client (`generate_secret = false`).
- Callback URLs: `https://photos.davidshubov.com/auth/callback`, `http://localhost:3000/auth/callback`.
- Logout URLs: `https://photos.davidshubov.com`, `http://localhost:3000`.

### Authorization code flow with PKCE + `state`

`/auth/login` route handler:

1. Generates a 32-byte random `state` and 32-byte random `code_verifier`.
2. Derives `code_challenge = base64url(SHA256(verifier))`.
3. Sets two httpOnly cookies: `oauth_state` and `pkce_verifier`, both `Secure`, `SameSite=Lax`, `path=/auth/callback`, `max-age=600`.
4. Redirects to Cognito `/oauth2/authorize?response_type=code&client_id=…&redirect_uri=…&scope=openid+email+profile&state=…&code_challenge=…&code_challenge_method=S256`.

`/auth/callback` route handler:

1. Reads `state` query param and `oauth_state` cookie; rejects on mismatch.
2. Reads `pkce_verifier` cookie; exchanges `code` at Cognito `/oauth2/token` with the verifier.
3. Sets session cookies (see below), deletes `oauth_state` and `pkce_verifier` by setting them with `Max-Age=0` and the **same `path=/auth/callback`** they were created with (browsers ignore deletion `Set-Cookie` headers whose path doesn't match the original), redirects to `/`.

`/auth/logout` route handler: clears all auth cookies, redirects to Cognito `/logout?client_id=…&logout_uri=…`.

### Session cookies

Four cookies in total. All `httpOnly`, `Secure`, `SameSite=Lax`.

| Cookie            | Path             | Max-Age      | Purpose                                                |
| ----------------- | ---------------- | ------------ | ------------------------------------------------------ |
| `id_token`        | `/`              | id_token exp | Sent as `Authorization: Bearer` to API Gateway         |
| `refresh_token`   | `/auth/refresh`  | 30 days      | Only sent on the refresh endpoint; smaller blast radius |
| `oauth_state`     | `/auth/callback` | 600s         | Transient, deleted after callback                      |
| `pkce_verifier`   | `/auth/callback` | 600s         | Transient, deleted after callback                      |

Path-scoping `refresh_token` keeps it out of every other request's headers — reduces both header bloat and exposure.

### Token refresh

**Refresh runs in `middleware.ts`, not in `lib/api/client.ts`.** Server Components can only *read* cookies in Next.js; they cannot write them. So a "401 → refresh → retry" wrapper called from a Server Component would never persist new tokens. Middleware (and Route Handlers / Server Actions) *can* write cookies, so refresh happens there preemptively.

`middleware.ts` runs on every request to gallery and admin routes:

1. Reads `id_token` cookie; decodes the `exp` claim without verification (signature trusted; cookie is httpOnly + Secure).
2. If `exp - now < 60s` and `refresh_token` cookie is present:
   - POSTs to Cognito `/oauth2/token` with `grant_type=refresh_token`.
   - On success: writes the new `id_token` (Cognito does not rotate `refresh_token` by default, so the existing one is left untouched).
   - On failure: clears all session cookies and lets the request through; downstream code sees an unauthenticated state.
3. Continues to the route. The Server Component reads the (now-fresh) cookie.

`/auth/refresh` route handler exists for the browser-triggered case (e.g., a long-lived tab whose middleware doesn't fire because the user hasn't navigated). It does the same exchange and returns 204 or 401. Not called from Server Components.

`lib/api/client.ts` wraps server-side fetches to API Gateway with the bearer header. It does **not** attempt refresh; if it gets a 401, it returns the unauthenticated response shape and the caller renders accordingly. Middleware is the single refresh path.

### Role storage

`users` table in DynamoDB. PK `email` (lowercased), attribute `role` ∈ {`admin`, `viewer`}. Lambda reads on every authenticated call. Single source of truth for both the viewer whitelist and admin role.

Tradeoff acknowledged: one extra `GetItem` (~5ms) per authenticated request vs. embedding the role as a Cognito group claim. Chose DDB to match GOAL.md and keep one identity store.

### Admin seeding

`infra/aws/dynamodb.tf` includes an `aws_dynamodb_table_item` resource that creates the initial admin row, keyed by `var.admin_email`. Default `david.shubov@gmail.com`. Set via `terraform.tfvars`.

---

## Storage & delivery

### S3

Single bucket, two prefixes:

- `originals/` — private, no CloudFront origin. S3 event notification (`ObjectCreated`, prefix `originals/`) triggers the resize Lambda.
- `processed/` — read by CloudFront via OAC only. Bucket policy permits `cloudfront.amazonaws.com` service principal on `processed/*` only; everything else denied.

Block all public access on the bucket. CORS on the bucket allows `POST` from `https://photos.davidshubov.com` and `http://localhost:3000` for presigned uploads.

Accepted upload formats: **JPEG, PNG, WebP**. HEIC explicitly out of scope for v1 (admin converts on Mac before upload). Validation enforced both client-side (file picker accept) and server-side (presign Lambda checks content-type before issuing policy).

### CloudFront

- OAC origin pointed at the S3 bucket, restricted to the `processed/` prefix path.
- Alternate domain: **`cdn.photos.davidshubov.com`**.
- ACM cert in us-east-1, DNS validation via CNAME added manually in Vercel DNS (Vercel manages the root `davidshubov.com` zone).
- Final `cdn.photos.davidshubov.com` → CloudFront distribution domain mapping also added manually in Vercel DNS.
- Cache behaviors:
  - Image objects (`processed/*.webp`): long TTL (1 year), immutable (content-addressed keys).
  - No manifest in v1; listing comes from API.

`next/image` `images.remotePatterns` pins `cdn.photos.davidshubov.com`.

### DynamoDB

`photos` table — PK `photo_id` (UUID string).

| Attribute           | Type | Notes                                                  |
| ------------------- | ---- | ------------------------------------------------------ |
| `photo_id`          | S    | PK                                                     |
| `is_public`         | BOOL | Also serialized as string `"true"`/`"false"` for GSI   |
| `title`             | S    | From admin upload form via `x-amz-meta-title`          |
| `original_filename` | S    | Fallback reference                                     |
| `created_at`        | S    | ISO8601                                                |
| `original_key`      | S    | `originals/{photo_id}/{filename}`                      |
| `variants`          | M    | `{ thumb, medium, large }` → keys under `processed/`   |

GSI `public-index`: PK `is_public_str` (string), SK `created_at`. Public queries hit a single partition (the literal `"true"`) — acceptable at portfolio scale (hundreds to low thousands). Future shard option noted below.

`users` table — PK `email` (lowercased), attribute `role`.

---

## API

API Gateway REST, stage `prod`.

| Method   | Path              | Auth                 | Lambda        |
| -------- | ----------------- | -------------------- | ------------- |
| `GET`    | `/photos`         | `NONE`               | `list_photos` |
| `GET`    | `/photos/private` | `COGNITO_USER_POOLS` | `list_photos` |
| `POST`   | `/admin/presign`  | `COGNITO_USER_POOLS` | `admin`       |
| `DELETE` | `/admin/photo`    | `COGNITO_USER_POOLS` | `admin`       |

Path split (`/photos` vs `/photos/private`) resolves the "same route, two auth modes" tension in GOAL.md. The whitelist check happens inside `list_photos` after the Cognito authorizer validates the JWT — if the email isn't in `users`, Lambda returns 403.

### Pagination (v1)

`GET /photos` and `GET /photos/private`: sort by `created_at` desc, hard `Limit=60`, no cursor. Gallery renders the page in one shot; `next/image` lazy-loads off-screen.

### Pagination (planned scale-up — not v1)

When photo count crosses ~60 or first-page latency degrades:

- Add optional `?cursor=<opaque>&limit=<n>` (default 60, max 100). No-cursor behavior preserved → non-breaking change.
- Base64-encode `LastEvaluatedKey` for the cursor.
- Frontend: Server Component renders page 1 for first paint; client-side `useInfiniteScroll` hook fetches subsequent pages via `IntersectionObserver` on a sentinel.
- If public photo count ever crosses ~10K with concurrent load, shard `is_public_str` GSI partition key (`"true#0"` … `"true#9"`) and query all shards in parallel. Not a v1 concern.

### Throttling

API Gateway default account throttle (10,000 rps, burst 5,000) is far above expected load; no per-route override needed for v1.

---

## Lambdas

All Python 3.12, us-east-1. CloudWatch log retention 14 days.

**Pillow layer for `resize`:** AWS does not publish an official Pillow layer. Two options:

- **Klayers community ARN (recommended for v1)** — e.g., `arn:aws:lambda:us-east-1:770693421928:layer:Klayers-p312-Pillow:<version>`. Stable, versioned, maintained at `github.com/keithrozario/Klayers`. Reference the ARN as a `var.pillow_layer_arn` in `variables.tf`, looked up at deploy time from Klayers' published manifest.
- **Build our own** — Docker-built zip uploaded via `aws_lambda_layer_version`. Matches the `radiant/` ffmpeg-layer pattern but adds CI complexity. Defer unless Klayers becomes unavailable.

### `resize` (S3 trigger)

- Trigger: S3 `ObjectCreated:*` on `originals/` prefix only.
- Timeout 60s, memory 1024MB.
- Reads object, decodes via Pillow, strips all EXIF.
- Reads `x-amz-meta-title` and `x-amz-meta-is-public` from `head_object`. Parses `original_filename` from the S3 key (`originals/{photo_id}/{filename}`) — not from metadata.
- Produces three WebP variants: `thumb` (400w), `medium` (1200w), `large` (2400w).
- Writes to `processed/{photo_id}/{size}.webp` with `Cache-Control: public, max-age=31536000, immutable`.
- Upserts the DDB row: sets `title`, `original_filename`, `is_public` (BOOL + `is_public_str`), `created_at` (ISO8601 UTC), `original_key`, `variants`.

### `list_photos` (API Gateway)

- Public mode: queries `public-index` GSI where `is_public_str = "true"`, `Limit=60`, `ScanIndexForward=false`.
- Authenticated mode:
  1. Parses email from `requestContext.authorizer.claims.email`.
  2. `GetItem` on `users` by lowercased email.
  3. If absent → 403.
  4. If `role` ∈ {`viewer`, `admin`}: `Scan` the `photos` table, sort by `created_at` desc **in the Lambda**, return top 60. The base table has no ordering index, and at portfolio scale (hundreds of items, ~1KB each) a full scan is sub-100ms and well under the 1MB scan response limit. When item count crosses ~1000 or scan latency degrades, replace with an `all-photos-index` GSI (constant PK `"all"`, SK `created_at`) — same hot-partition tradeoff as `public-index`, same shard plan applies.
- Response: `{ photos: [{ id, title, urls: { thumb, medium, large }, isPublic, createdAt }] }`. URLs are absolute `https://cdn.photos.davidshubov.com/...` strings.

### `admin` (API Gateway, two routes)

**`POST /admin/presign`**

Request body: `{ filename, contentType, title, isPublic }`.

1. Auth check: parses email from JWT claims, reads `users`, requires `role = admin`. 403 otherwise.
2. Validates `contentType` ∈ {`image/jpeg`, `image/png`, `image/webp`}.
3. Generates `photo_id = uuid4()`.
4. Builds a presigned POST policy targeting `originals/{photo_id}/{filename}` with **exact-value conditions** on:
   - `bucket`
   - `key` (exact match)
   - `Content-Type` (exact match)
   - `x-amz-meta-title` (exact match, from request body)
   - `x-amz-meta-is-public` (exact match, `"true"` or `"false"`)
   - `content-length-range` (0 to 50MB)
5. Returns `{ url, fields, photoId }`.

**`DELETE /admin/photo`**

Request body: `{ photoId }`.

1. Auth check (same).
2. `GetItem` from `photos` to read `original_key` and `variants`.
3. **S3 first**: batch `delete_objects` for the original key plus all three variant keys. If any sub-delete fails, retry the failed subset once. If still failing, return 500 — DDB is untouched, photo remains in gallery, admin retries (idempotent).
4. **DDB second**: `DeleteItem` on `photos`. Retry once on transient error. If irrecoverable, emit CloudWatch metric → alarm → email.

No background sweeper. Reconciliation is a manual script (`scripts/reconcile.py`) the admin runs on demand:

- Lists all `photos` rows and all `originals/*` + `processed/*` keys.
- Reports DDB rows missing S3 objects and S3 objects missing DDB rows.
- `--apply` flag deletes the orphaned side after confirmation.

---

## Frontend

### Routes

- `app/page.tsx` — public gallery. Server Component fetches `GET /photos`. If `id_token` cookie present, also fetches `/photos/private` and merges by `photo_id` (dedupe). A 403 from `/photos/private` (signed in but not whitelisted) is swallowed silently — the page renders the public set only; signing in is not an error condition.
- `app/admin/page.tsx` — admin upload + delete UI. Server-guarded: middleware redirects unauthenticated; Server Component verifies `role = admin` by calling a helper that reads `users`.
- `app/auth/login/route.ts`, `app/auth/callback/route.ts`, `app/auth/logout/route.ts`, `app/auth/refresh/route.ts`.
- `middleware.ts` — guards `/admin/*`; redirects to `/auth/login` if `id_token` cookie missing or expired.

### Libraries

- `lib/auth/session.ts` — reads `id_token` cookie, validates expiry, exposes claims.
- `lib/auth/cognito.ts` — token exchange + refresh helpers.
- `lib/api/client.ts` — server-side fetch with bearer header, 401 → refresh → retry-once.

### Components

Each in its own folder per `CLAUDE.md`:

- `components/PhotoGrid/` — responsive grid, `next/image`.
- `components/AdminUpload/` — form with title field, public toggle, file picker; POSTs to `/admin/presign`, then POSTs to S3 with returned fields, then polls `GET /photos/private` every 1s until the new `photoId` appears. Shows a "processing…" indicator with elapsed time; gives up at 60s with a "still processing — refresh later" message (the photo will appear once resize completes regardless).
- `components/AdminPhotoList/` — admin view of all photos with per-row delete button.

### Env vars (Vercel)

```
COGNITO_DOMAIN=
COGNITO_CLIENT_ID=
COGNITO_REDIRECT_URI=https://photos.davidshubov.com/auth/callback
COGNITO_LOGOUT_URI=https://photos.davidshubov.com
API_GATEWAY_URL=
CLOUDFRONT_URL=https://cdn.photos.davidshubov.com
```

Local dev uses `.env.local` with the same keys but `http://localhost:3000/...` callbacks.

---

## Terraform

Layout (under `infra/aws/`):

```
main.tf            # provider, backend, locals
variables.tf       # region (default us-east-1), site_domain, admin_email, google_auth_*
outputs.tf         # API URL, CloudFront domain, Cognito IDs, bucket name
cognito.tf         # User pool, hosted UI domain, Google IdP, app client
s3.tf              # Bucket, CORS, bucket policy (CloudFront OAC only on processed/*)
cloudfront.tf      # OAC, distribution, ACM cert reference, alternate domain
acm.tf             # us-east-1 cert for cdn.photos.davidshubov.com (DNS validation)
dynamodb.tf        # photos table + GSI, users table, admin seed item
api_gateway.tf     # REST API, Cognito authorizer, methods, integrations, stage
lambdas.tf         # 3 functions, IAM roles/policies, S3 event notification
lambda/
  list_photos/main.py
  admin/main.py
  resize/main.py
```

Lambda packaging: pure-Python sources zipped via `archive_file` data sources. `resize` references the public AWS Pillow layer ARN for us-east-1.

`terraform.tfvars` (gitignored) holds:

```hcl
google_auth_client_id     = "..."
google_auth_client_secret = "..."
admin_email               = "david.shubov@gmail.com"
site_domain               = "photos.davidshubov.com"
cdn_domain                = "cdn.photos.davidshubov.com"
```

Scripts:

- `scripts/deploy.sh` — runs `terraform apply`, prints the Vercel env-var checklist from outputs.
- `scripts/teardown.sh` — runs `terraform destroy`.
- `scripts/reconcile.py` — manual orphan reconciliation, described above.

---

## DNS / cert workflow

Because Vercel manages `davidshubov.com`:

1. `terraform apply` creates the ACM cert (us-east-1, DNS validation) and waits.
2. Admin copies the validation CNAME from `terraform output` into the Vercel DNS dashboard.
3. Once ACM validates, Terraform completes the CloudFront distribution with the alternate domain.
4. Admin adds the final `cdn.photos.davidshubov.com` CNAME → CloudFront distribution domain in Vercel DNS.
5. Vercel project for the Next.js app is configured to serve `photos.davidshubov.com` (standard Vercel domain wiring).

`photos.davidshubov.com` → Vercel; `cdn.photos.davidshubov.com` → CloudFront. They are separate and independent.

---

## Verification checklist (before declaring done)

- [ ] Anonymous visitor sees only `is_public = true` photos at `photos.davidshubov.com`.
- [ ] Non-whitelisted signed-in user gets 403 on `/photos/private`.
- [ ] Whitelisted viewer sees all photos.
- [ ] Admin can upload via `/admin`, photo appears within the polling window (60s) for a typical 5–10MB JPEG.
- [ ] Admin can delete; photo disappears immediately, S3 keys gone.
- [ ] `originals/` not accessible via CloudFront or public S3 URL.
- [ ] Processed variants strip EXIF; only `title` preserved (verified via `exiftool`).
- [ ] All auth cookies httpOnly; no tokens in localStorage or document.cookie-readable form.
- [ ] `/admin` inaccessible without `role = admin`.
- [ ] Token expiry triggers refresh transparently; user does not see a redirect.
- [ ] OAuth state mismatch on `/auth/callback` is rejected.
- [ ] PKCE verifier is required for the token exchange (verified by removing the verifier cookie and confirming the exchange fails).
- [ ] `scripts/reconcile.py` correctly identifies orphans when a row or object is removed out-of-band.

---

## Risks and mitigations

| Risk                                                          | Mitigation                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Cognito callback URL mismatch                                 | Exact match enforced in Cognito client, Vercel env, and Google OAuth console              |
| `refresh_token` cookie expiry mid-session                      | Cognito does not rotate `refresh_token` by default; cookie max-age (30d) matches Cognito's default refresh lifetime. Expiry → next middleware run clears cookies and the user re-signs in via hosted UI. |
| ACM cert validation blocks on manual DNS step                 | `deploy.sh` prints the CNAME prominently and waits for user confirmation before continuing |
| Cookie size with 4 cookies                                    | Path-scoping `refresh_token` keeps it off the hot path; total per-request cookie ~3–4KB    |
| DDB delete fails after S3 delete                              | CloudWatch alarm + email; admin re-runs delete (idempotent)                               |
| Hot partition on `public-index` GSI                           | Acceptable at portfolio scale; shard plan documented above for future                     |
| `aws_dynamodb_table_item` drift                               | Single bootstrap row; not edited after creation; acceptable                                |

---

## Out of scope (v1)

- HEIC ingest
- Multi-region or multi-AZ failover
- Background reconciliation / sweeper jobs
- Cursor-based pagination
- CloudFront cache invalidation (objects are immutable; no manifest in v1)
- Manual photo ordering / curation
- Per-photo access control beyond `is_public` boolean
- Image upload progress / virus scanning
- Comment, like, or share features
