# Photo Subdomain Project — Architecture Summary

## Overview

A photography subdomain (`photos.davidshubov.com`) hosted on Vercel (Next.js), backed by AWS infrastructure. The goal is a portfolio photo site with a whitelisted "friends and family" tier that sees all photos, anonymous users see only public-flagged photos, and an admin-only upload flow. Doubles as an intentional infra learning project.

---

## Frontend

- Next.js on Vercel, separate project from `davidshubov.com` pointed at `photos.davidshubov.com`
- `davidshubov.com` photos link does a 301 to the subdomain
- Public photos served directly from CloudFront URLs, no auth required to view them
- Whitelisted users see additional photos after signing in
- `/admin` route guard — only accessible to admin role, renders upload UI
- Token stored in httpOnly cookie, set server-side on Cognito callback at `/auth/callback`

---

## Auth

- Cognito User Pool with Google federated IdP
- Cognito hosted UI handles the OAuth dance, redirects back to `photos.davidshubov.com/auth/callback` with JWT
- Frontend passes JWT as Authorization header to API Gateway
- API Gateway Cognito authorizer validates token before Lambda is ever invoked
- Viewer whitelist and admin role stored in DynamoDB, Lambda checks these after API Gateway validates the JWT

---

## AWS Infrastructure

- **S3** — two prefixes: `/originals/` (private, never served) and `/processed/` (CloudFront only via OAC)
- **CloudFront** — Origin Access Control (OAC); only CloudFront can read S3, bucket is fully private
- **API Gateway** — Cognito authorizer on all authenticated routes
- **Lambda** — three functions:
  - Photo retrieval (checks whitelist, returns CloudFront URLs)
  - Presigned POST generator (checks admin role)
  - Resize + EXIF strip (triggered by S3 event)
- **S3 Event Notifications** — `ObjectCreated` on `/originals/` prefix triggers resize Lambda directly; no EventBridge needed at this scale
- **DynamoDB**:
  - `photos` table: `photo_id`, `s3_key`, `is_public`, `title`, metadata
  - `users` table: `email`, `role: admin|viewer`

---

## Resize Lambda

- Triggered on upload to `/originals/`
- Strips all EXIF metadata — title is the only field preserved
- Generates 2-3 web-optimized sizes
- Writes output to `/processed/` prefix
- Originals are never exposed

---

## API Routes

| Method   | Route            | Auth             | Description                                            |
| -------- | ---------------- | ---------------- | ------------------------------------------------------ |
| `GET`    | `/photos`        | None             | CloudFront direct — returns public-flagged photos only |
| `GET`    | `/photos`        | JWT              | API Gateway → Lambda → whitelist check → all photos    |
| `POST`   | `/admin/presign` | JWT + admin role | Lambda returns presigned POST fields for S3 upload     |
| `DELETE` | `/admin/photo`   | JWT + admin role | Lambda deletes from S3 and DynamoDB                    |

---

## Terraform

- Existing Cognito code to be ported and extended with Google federated IdP
- S3, CloudFront OAC, API Gateway, Lambda, DynamoDB all defined in Terraform
- Presigned POST pattern used for uploads — credentials never touch GitHub

---

## Open Questions for the Agent

- Confirm existing Cognito Terraform has Google IdP configured, or whether it needs adding
- Confirm Next.js version and whether app router or pages router (affects auth callback implementation)
- Decide on CloudFront cache invalidation strategy when new photos are uploaded
