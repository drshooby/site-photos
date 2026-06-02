# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Next.js version warning

This is NOT the Next.js you know. This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

## Commands

```bash
bun dev          # dev server on localhost:3000
bun build        # production build
bun lint         # eslint
```

Infra (from `infra/aws/` once scaffolded):
```bash
terraform init
terraform plan
terraform apply
terraform destroy
```

## Architecture overview

`photos.davidshubov.com` — a Next.js 16 (App Router) portfolio photo site on Vercel backed by AWS.

**Full plan:** [`photo_subdomain_build_69d4eecc.plan.md`](photo_subdomain_build_69d4eecc.plan.md) — read it before starting any new phase. It contains resolved open questions, what to port vs skip from `radiant/`, DynamoDB schema, Lambda specs, and a verification checklist.

### Frontend (`app/`)
- App Router, React 19, TypeScript
- Auth: Cognito + Google OAuth, httpOnly cookie session set at `/auth/callback`; **do not** use `react-oidc-context` or client-side token storage
- Token in cookie is `id_token` (required by API Gateway Cognito authorizer)
- `middleware.ts` guards `/admin/*`
- `lib/auth/session.ts` — reads cookie, validates expiry, used by Server Components
- `lib/api/client.ts` — server-side fetch to API Gateway with `Authorization: Bearer <token>`
- Photos rendered via `next/image` with `images.remotePatterns` pointing at CloudFront domain

### AWS infrastructure (`infra/aws/` — greenfield, not yet created)
Terraform. Reference patterns live in `radiant/infra/aws/`; the plan doc lists exactly what to port and what to skip.

- **S3** — single bucket, two prefixes: `originals/` (private, S3-trigger only) and `processed/` (CloudFront OAC only)
- **CloudFront** — OAC origin on `processed/`; long TTL for image objects, short for `manifests/*`
- **DynamoDB** — `photos` table (PK: `photo_id`; GSI on `is_public` + `created_at`) and `users` table (PK: `email`, attr: `role`)
- **API Gateway** — `GET /photos` (no auth → public only), `GET /photos/private` (Cognito authorizer → whitelist check), `POST /admin/presign`, `DELETE /admin/photo`
- **Lambdas** (Python 3.12): `resize` (S3 ObjectCreated trigger on `originals/`), `list_photos`, `admin` (presign POST + delete)

### `radiant/` — reference architecture only
Do not modify. Contains working Terraform (Cognito, API GW, presigned URL Lambda, S3) and a Next.js app using `react-oidc-context`. Port patterns as specified in the plan doc; ignore RDS, VPC, Step Functions, EventBridge, Rekognition.

## Environment variables

**Next.js (`.env.local`):**
```
COGNITO_DOMAIN=
COGNITO_CLIENT_ID=
COGNITO_REDIRECT_URI=https://photos.davidshubov.com/auth/callback
COGNITO_LOGOUT_URI=https://photos.davidshubov.com
API_GATEWAY_URL=
CLOUDFRONT_URL=
```

**Lambda (set via Terraform):** `PHOTOS_TABLE`, `USERS_TABLE`, `CLOUDFRONT_DOMAIN`, `BUCKET_NAME`

## Component structure

Each component lives in its own folder under `components/` with this layout:

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

- Originals (`originals/` prefix) must never be accessible via CloudFront or public S3
- Resize Lambda strips all EXIF; only `ImageDescription`/title is preserved into DynamoDB
- Presigned upload uses POST policy (not PUT) targeting `originals/{photo_id}/{filename}`
- `is_public` defaults to `false` on upload; admin UI sends it as S3 object metadata `x-amz-meta-is-public`
