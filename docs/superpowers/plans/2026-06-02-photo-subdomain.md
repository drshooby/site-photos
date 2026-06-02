# Photo Subdomain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `photos.davidshubov.com` — a Next.js 16 portfolio photo site on Vercel backed by AWS (Cognito + Google IdP, S3 + CloudFront OAC, DynamoDB, 3 Python Lambdas via API Gateway).

**Architecture:** Vercel-hosted Next.js App Router acts as UI + auth BFF (httpOnly cookies, PKCE + state). API Gateway REST with Cognito authorizer fronts three Python 3.12 Lambdas (`resize`, `list_photos`, `admin`). Photo bytes live in a private S3 bucket with two prefixes (`originals/`, `processed/`); only CloudFront (via OAC) can read processed variants. DynamoDB holds photo metadata + user roles.

**Tech Stack:** Next.js 16.2.7 + React 19 + TypeScript + Bun · Python 3.12 Lambdas + Pillow (Klayers layer) · Terraform (AWS provider) · Cognito + Google OAuth · DynamoDB · S3 · CloudFront OAC · API Gateway REST · pytest + moto for Lambda tests · Vitest for Next.js tests.

**Specification:** [`docs/superpowers/specs/2026-06-02-photo-subdomain-design.md`](../specs/2026-06-02-photo-subdomain-design.md). Read it before starting any phase.

---

## File structure

### Terraform (`infra/aws/`)

| File | Responsibility |
| --- | --- |
| `main.tf` | Provider, terraform block, locals |
| `variables.tf` | All inputs: region, domains, admin_email, google_auth_*, pillow_layer_arn |
| `outputs.tf` | API URL, CloudFront domain, Cognito IDs, bucket name, ACM validation CNAME |
| `s3.tf` | Bucket, public-access block, CORS, bucket policy |
| `dynamodb.tf` | `photos` table (+ GSI), `users` table, admin seed item |
| `cognito.tf` | User pool, hosted UI domain, Google IdP, app client |
| `acm.tf` | us-east-1 cert for `cdn.photos.davidshubov.com` |
| `cloudfront.tf` | OAC, distribution, alternate domain |
| `iam.tf` | Lambda execution roles + policies |
| `lambdas.tf` | Three `aws_lambda_function` + `archive_file` data sources + S3 event notification |
| `api_gateway.tf` | REST API, Cognito authorizer, resources, methods, integrations, stage |
| `lambda/list_photos/main.py` | List handler |
| `lambda/list_photos/test_main.py` | Pytest |
| `lambda/admin/main.py` | Presign + delete handler |
| `lambda/admin/test_main.py` | Pytest |
| `lambda/resize/main.py` | Resize handler |
| `lambda/resize/test_main.py` | Pytest |
| `lambda/requirements-dev.txt` | pytest, moto, pillow |

### Next.js (`app/`, `lib/`, `components/`, root)

| File | Responsibility |
| --- | --- |
| `lib/auth/cognito.ts` | Token exchange + refresh helpers (server-only) |
| `lib/auth/session.ts` | Cookie read, JWT claim decode (no verify), expiry helpers |
| `lib/auth/pkce.ts` | `state` + `code_verifier` + `code_challenge` generation |
| `lib/api/client.ts` | Server-side fetch to API Gateway with bearer header |
| `middleware.ts` | Preemptive token refresh + `/admin` guard |
| `app/auth/login/route.ts` | Sets PKCE/state cookies, redirects to Cognito |
| `app/auth/callback/route.ts` | Verifies state, exchanges code, sets session cookies |
| `app/auth/logout/route.ts` | Clears cookies, redirects to Cognito logout |
| `app/auth/refresh/route.ts` | Browser-triggered refresh fallback |
| `app/page.tsx` | Public gallery (Server Component) |
| `app/admin/page.tsx` | Admin UI (Server Component, role-guarded) |
| `components/PhotoGrid/` | Responsive grid + `next/image` |
| `components/AdminUpload/` | Form + presign POST + S3 POST + poll |
| `components/AdminPhotoList/` | Photo list + delete button |
| `next.config.ts` | `images.remotePatterns` for CDN |
| `.env.local.example` | Documented template |

### Scripts (`scripts/`)

| File | Responsibility |
| --- | --- |
| `deploy.sh` | `terraform apply`, print env-var checklist |
| `teardown.sh` | `terraform destroy` |
| `reconcile.py` | Manual orphan reconciliation |

---

## Phase 0 — Repo prep

### Task 1: Add `.gitignore` entries and create directory skeleton

**Files:**
- Modify: `.gitignore`
- Create: `infra/aws/`, `lambda/list_photos/`, `lambda/admin/`, `lambda/resize/`, `scripts/`, `lib/auth/`, `lib/api/`, `components/`, `docs/superpowers/`

- [ ] **Step 1: Append to `.gitignore`**

```
# Terraform
infra/aws/.terraform/
infra/aws/.terraform.lock.hcl
infra/aws/terraform.tfstate
infra/aws/terraform.tfstate.backup
infra/aws/terraform.tfvars
infra/aws/*.zip

# Python
__pycache__/
*.py[cod]
.pytest_cache/
.venv/

# Local env
.env.local
```

- [ ] **Step 2: Create empty directories**

```bash
mkdir -p infra/aws/lambda/{list_photos,admin,resize} scripts lib/auth lib/api components
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: prep repo for photo subdomain build"
```

---

## Phase 1 — Terraform foundation

### Task 2: Provider and variables

**Files:**
- Create: `infra/aws/main.tf`
- Create: `infra/aws/variables.tf`

- [ ] **Step 1: Write `main.tf`**

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project = "photo-subdomain"
      Owner   = "david"
      Managed = "terraform"
    }
  }
}

locals {
  project = "photos"
}
```

- [ ] **Step 2: Write `variables.tf`**

```hcl
variable "region" {
  description = "AWS region — pinned to us-east-1 for ACM/CloudFront."
  type        = string
  default     = "us-east-1"
}

variable "site_domain" {
  description = "Public site domain served by Vercel."
  type        = string
  default     = "photos.davidshubov.com"
}

variable "cdn_domain" {
  description = "CloudFront alternate domain for processed image delivery."
  type        = string
  default     = "cdn.photos.davidshubov.com"
}

variable "admin_email" {
  description = "Email address seeded as the initial admin in DynamoDB users table."
  type        = string
  default     = "david.shubov@gmail.com"
}

variable "google_auth_client_id" {
  description = "Google OAuth client ID used by Cognito as a federated IdP."
  type        = string
  sensitive   = true
}

variable "google_auth_client_secret" {
  description = "Google OAuth client secret used by Cognito as a federated IdP."
  type        = string
  sensitive   = true
}

variable "pillow_layer_arn" {
  description = "Klayers Pillow layer ARN for Python 3.12 in us-east-1."
  type        = string
  # Update version periodically from https://api.klayers.cloud/api/v2/p3.12/layers/latest/us-east-1/json/Pillow
}

variable "callback_urls" {
  description = "Cognito callback URLs."
  type        = list(string)
  default = [
    "https://photos.davidshubov.com/auth/callback",
    "http://localhost:3000/auth/callback",
  ]
}

variable "logout_urls" {
  description = "Cognito logout URLs."
  type        = list(string)
  default = [
    "https://photos.davidshubov.com",
    "http://localhost:3000",
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add infra/aws/main.tf infra/aws/variables.tf
git commit -m "feat(infra): terraform provider + variables"
```

### Task 3: S3 bucket

**Files:**
- Create: `infra/aws/s3.tf`

- [ ] **Step 1: Write `s3.tf`**

```hcl
resource "aws_s3_bucket" "photos" {
  bucket        = "${local.project}-${data.aws_caller_identity.current.account_id}"
  force_destroy = false
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_public_access_block" "photos" {
  bucket                  = aws_s3_bucket.photos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = [
      "https://${var.site_domain}",
      "http://localhost:3000",
    ]
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# Bucket policy attached in cloudfront.tf once OAC exists.
```

- [ ] **Step 2: Commit**

```bash
git add infra/aws/s3.tf
git commit -m "feat(infra): private S3 bucket with CORS for presigned uploads"
```

### Task 4: DynamoDB tables and admin seed

**Files:**
- Create: `infra/aws/dynamodb.tf`

- [ ] **Step 1: Write `dynamodb.tf`**

```hcl
resource "aws_dynamodb_table" "photos" {
  name         = "${local.project}-photos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "photo_id"

  attribute {
    name = "photo_id"
    type = "S"
  }

  attribute {
    name = "is_public_str"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "S"
  }

  global_secondary_index {
    name            = "public-index"
    hash_key        = "is_public_str"
    range_key       = "created_at"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "users" {
  name         = "${local.project}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "email"

  attribute {
    name = "email"
    type = "S"
  }
}

resource "aws_dynamodb_table_item" "admin_seed" {
  table_name = aws_dynamodb_table.users.name
  hash_key   = aws_dynamodb_table.users.hash_key

  item = jsonencode({
    email = { S = lower(var.admin_email) }
    role  = { S = "admin" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/aws/dynamodb.tf
git commit -m "feat(infra): photos + users tables with admin seed"
```

### Task 5: Cognito user pool + Google IdP + app client

**Files:**
- Create: `infra/aws/cognito.tf`

- [ ] **Step 1: Write `cognito.tf`**

```hcl
resource "aws_cognito_user_pool" "main" {
  name                     = "${local.project}-users"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "${local.project}-${data.aws_caller_identity.current.account_id}"
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_auth_client_id
    client_secret    = var.google_auth_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    username = "sub"
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.project}-web"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = false
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  supported_identity_providers         = ["Google"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.logout_urls

  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  refresh_token_validity = 30
  id_token_validity      = 60
  access_token_validity  = 60
  token_validity_units {
    refresh_token = "days"
    id_token      = "minutes"
    access_token  = "minutes"
  }

  prevent_user_existence_errors = "ENABLED"

  depends_on = [aws_cognito_identity_provider.google]
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/aws/cognito.tf
git commit -m "feat(infra): cognito user pool + google idp"
```

### Task 6: `terraform.tfvars` + Klayers Pillow ARN lookup

**Files:**
- Create: `infra/aws/terraform.tfvars` (gitignored)

- [ ] **Step 1: Look up the current Klayers Pillow ARN**

Run:
```bash
curl -s https://api.klayers.cloud/api/v2/p3.12/layers/latest/us-east-1/json/Pillow | python3 -c "import sys,json;print(json.load(sys.stdin)['arn'])"
```
Expected: an ARN like `arn:aws:lambda:us-east-1:770693421928:layer:Klayers-p312-Pillow:N`. Copy it.

- [ ] **Step 2: Create `infra/aws/terraform.tfvars`** (this file is gitignored — do not commit)

```hcl
google_auth_client_id     = "YOUR_GOOGLE_CLIENT_ID"
google_auth_client_secret = "YOUR_GOOGLE_CLIENT_SECRET"
pillow_layer_arn          = "arn:aws:lambda:us-east-1:770693421928:layer:Klayers-p312-Pillow:N"
```

> **Manual user step:** The user must already have a Google OAuth client configured at `console.cloud.google.com` with `https://<pool-domain>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` as an authorized redirect URI. The exact pool domain is only known after `terraform apply` runs Cognito, so this is a two-pass setup — see Task 8.

### Task 7: First `terraform init` + initial apply (Cognito + S3 + DynamoDB only)

**Files:** none new

- [ ] **Step 1: `terraform init`**

Run from `infra/aws/`:
```bash
cd infra/aws && terraform init
```
Expected: "Terraform has been successfully initialized!"

- [ ] **Step 2: `terraform plan`**

```bash
terraform plan
```
Expected: ~12 resources to add (S3 + public-access-block + CORS + 2 DDB tables + admin item + Cognito pool + domain + IdP + client). No errors.

- [ ] **Step 3: `terraform apply`**

```bash
terraform apply
```
Type `yes`. Expected: apply completes. Capture the Cognito user pool domain output for Task 8.

- [ ] **Step 4: Commit (no infra files change, but lock the milestone)**

```bash
cd ../.. && git commit --allow-empty -m "chore(infra): initial cognito+s3+ddb apply"
```

### Task 8: Add Cognito redirect URI to Google OAuth client (manual)

**Files:** none

- [ ] **Step 1: Get pool domain**

```bash
cd infra/aws && terraform output -raw cognito_pool_domain
```
(This output is added in Task 11; for now, derive from the resource: it's `<local.project>-<account_id>.auth.us-east-1.amazoncognito.com`.)

- [ ] **Step 2: In Google Cloud Console → APIs & Services → Credentials → your OAuth client → Authorized redirect URIs**, add:

```
https://<pool-domain>/oauth2/idpresponse
```

Save.

---

## Phase 2 — ACM + CloudFront

### Task 9: ACM certificate for CDN domain

**Files:**
- Create: `infra/aws/acm.tf`

- [ ] **Step 1: Write `acm.tf`**

```hcl
resource "aws_acm_certificate" "cdn" {
  domain_name       = var.cdn_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records are added MANUALLY in Vercel DNS (Vercel manages the root zone).
# See outputs.tf for the CNAME values to copy.
```

- [ ] **Step 2: Commit**

```bash
git add infra/aws/acm.tf
git commit -m "feat(infra): ACM cert for CDN domain (manual DNS validation)"
```

### Task 10: CloudFront OAC + distribution + S3 bucket policy

**Files:**
- Create: `infra/aws/cloudfront.tf`

- [ ] **Step 1: Write `cloudfront.tf`**

```hcl
resource "aws_cloudfront_origin_access_control" "photos" {
  name                              = "${local.project}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "photos" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "photos.davidshubov.com — processed/ delivery"
  aliases         = [var.cdn_domain]

  origin {
    domain_name              = aws_s3_bucket.photos.bucket_regional_domain_name
    origin_id                = "s3-processed"
    origin_path              = "/processed"
    origin_access_control_id = aws_cloudfront_origin_access_control.photos.id

    s3_origin_config {
      origin_access_identity = ""
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-processed"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # AWS managed CachingOptimized
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate.cdn.arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  depends_on = [aws_acm_certificate.cdn]
}

data "aws_iam_policy_document" "s3_cloudfront_read" {
  statement {
    sid     = "AllowCloudFrontOACReadProcessed"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.photos.arn}/processed/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.photos.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "photos" {
  bucket = aws_s3_bucket.photos.id
  policy = data.aws_iam_policy_document.s3_cloudfront_read.json
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/aws/cloudfront.tf
git commit -m "feat(infra): cloudfront distribution + OAC + bucket policy"
```

### Task 11: Outputs for ACM validation + CDN + Vercel checklist

**Files:**
- Create: `infra/aws/outputs.tf`

- [ ] **Step 1: Write `outputs.tf`**

```hcl
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_pool_domain" {
  value = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
}

output "s3_bucket_name" {
  value = aws_s3_bucket.photos.id
}

output "cloudfront_distribution_domain" {
  value       = aws_cloudfront_distribution.photos.domain_name
  description = "Add a CNAME ${var.cdn_domain} → this value in Vercel DNS."
}

output "cdn_domain" {
  value = var.cdn_domain
}

output "acm_validation_cnames" {
  description = "Add each of these CNAMEs to Vercel DNS to validate the ACM cert."
  value = [
    for dvo in aws_acm_certificate.cdn.domain_validation_options : {
      name  = dvo.resource_record_name
      value = dvo.resource_record_value
    }
  ]
}
```

- [ ] **Step 2: Apply**

```bash
cd infra/aws && terraform apply
```
Type `yes`. Expected: ACM cert pending validation, CloudFront distribution pending deployment.

- [ ] **Step 3: Copy validation CNAMEs to Vercel DNS**

```bash
terraform output acm_validation_cnames
```
Add the CNAME in Vercel DNS for `davidshubov.com` zone. Wait for ACM to reach `ISSUED` (typically 5–30 minutes):

```bash
aws acm describe-certificate --certificate-arn $(terraform output -raw acm_certificate_arn 2>/dev/null) --query 'Certificate.Status' --region us-east-1
```

Once `ISSUED`, re-run `terraform apply` so CloudFront picks up the issued cert.

- [ ] **Step 4: Add CDN CNAME**

```bash
terraform output cloudfront_distribution_domain
```
Add a CNAME in Vercel DNS: `cdn.photos.davidshubov.com` → `<distribution>.cloudfront.net`.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add infra/aws/outputs.tf && git commit -m "feat(infra): outputs incl. ACM validation + Vercel CNAME"
```

---

## Phase 3 — Lambda IAM + packaging skeleton

### Task 12: IAM roles for each Lambda

**Files:**
- Create: `infra/aws/iam.tf`

- [ ] **Step 1: Write `iam.tf`**

```hcl
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# resize
resource "aws_iam_role" "resize" {
  name               = "${local.project}-resize"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "resize" {
  statement {
    actions   = ["s3:GetObject", "s3:HeadObject"]
    resources = ["${aws_s3_bucket.photos.arn}/originals/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.photos.arn}/processed/*"]
  }
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.photos.arn]
  }
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "resize" {
  role   = aws_iam_role.resize.id
  policy = data.aws_iam_policy_document.resize.json
}

# list_photos
resource "aws_iam_role" "list_photos" {
  name               = "${local.project}-list-photos"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "list_photos" {
  statement {
    actions   = ["dynamodb:Query", "dynamodb:Scan", "dynamodb:GetItem"]
    resources = [
      aws_dynamodb_table.photos.arn,
      "${aws_dynamodb_table.photos.arn}/index/*",
      aws_dynamodb_table.users.arn,
    ]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "list_photos" {
  role   = aws_iam_role.list_photos.id
  policy = data.aws_iam_policy_document.list_photos.json
}

# admin
resource "aws_iam_role" "admin" {
  name               = "${local.project}-admin"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "admin" {
  statement {
    actions = [
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:HeadObject",
    ]
    resources = ["${aws_s3_bucket.photos.arn}/*"]
  }
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [
      aws_dynamodb_table.photos.arn,
      "${aws_dynamodb_table.photos.arn}/index/*",
      aws_dynamodb_table.users.arn,
    ]
  }
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "admin" {
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin.json
}
```

- [ ] **Step 2: Commit**

```bash
git add infra/aws/iam.tf
git commit -m "feat(infra): IAM roles+policies for three lambdas"
```

### Task 13: Python dev requirements + pytest config

**Files:**
- Create: `lambda/requirements-dev.txt`
- Create: `lambda/conftest.py`
- Create: `lambda/pytest.ini`

- [ ] **Step 1: Write `lambda/requirements-dev.txt`**

```
pytest==8.3.3
moto[s3,dynamodb]==5.0.16
boto3==1.35.40
Pillow==10.4.0
```

- [ ] **Step 2: Write `lambda/conftest.py`**

```python
import os
import pytest


@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")
    monkeypatch.setenv("BUCKET_NAME", "test-bucket")
    monkeypatch.setenv("PHOTOS_TABLE", "test-photos")
    monkeypatch.setenv("USERS_TABLE", "test-users")
    monkeypatch.setenv("CLOUDFRONT_DOMAIN", "cdn.example.com")
```

- [ ] **Step 3: Write `lambda/pytest.ini`**

```ini
[pytest]
testpaths = list_photos admin resize
python_files = test_*.py
```

- [ ] **Step 4: Install + verify**

```bash
cd lambda && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt && pytest --collect-only
```
Expected: pytest runs, collects 0 tests (no test files yet), exits 0.

- [ ] **Step 5: Commit**

```bash
cd .. && git add lambda/
git commit -m "test(lambda): pytest scaffold with moto fixtures"
```

---

## Phase 4 — Resize Lambda

### Task 14: Resize handler — failing tests

**Files:**
- Create: `lambda/resize/test_main.py`

- [ ] **Step 1: Write the test file**

```python
import io
import json
import boto3
import pytest
from moto import mock_aws
from PIL import Image

from . import main as resize_main


def make_jpeg_bytes(width=3000, height=2000):
    img = Image.new("RGB", (width, height), color=(120, 180, 220))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


@pytest.fixture
def aws():
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-bucket")

        ddb = boto3.client("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="test-photos",
            KeySchema=[{"AttributeName": "photo_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "photo_id", "AttributeType": "S"},
                {"AttributeName": "is_public_str", "AttributeType": "S"},
                {"AttributeName": "created_at", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "public-index",
                    "KeySchema": [
                        {"AttributeName": "is_public_str", "KeyType": "HASH"},
                        {"AttributeName": "created_at", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        yield {"s3": s3, "ddb": ddb}


def put_original(s3, key, body, metadata):
    s3.put_object(
        Bucket="test-bucket",
        Key=key,
        Body=body,
        ContentType="image/jpeg",
        Metadata=metadata,
    )


def s3_event(key):
    return {
        "Records": [
            {
                "s3": {
                    "bucket": {"name": "test-bucket"},
                    "object": {"key": key},
                }
            }
        ]
    }


def test_resize_creates_three_webp_variants(aws):
    key = "originals/abc-123/photo.jpg"
    put_original(
        aws["s3"], key, make_jpeg_bytes(),
        {"title": "Sunset", "is-public": "true"},
    )

    resize_main.handler(s3_event(key), None)

    listed = aws["s3"].list_objects_v2(Bucket="test-bucket", Prefix="processed/abc-123/")
    keys = sorted(o["Key"] for o in listed["Contents"])
    assert keys == [
        "processed/abc-123/large.webp",
        "processed/abc-123/medium.webp",
        "processed/abc-123/thumb.webp",
    ]


def test_resize_writes_ddb_row(aws):
    key = "originals/abc-123/photo.jpg"
    put_original(
        aws["s3"], key, make_jpeg_bytes(),
        {"title": "Sunset", "is-public": "true"},
    )

    resize_main.handler(s3_event(key), None)

    item = aws["ddb"].get_item(
        TableName="test-photos",
        Key={"photo_id": {"S": "abc-123"}},
    )["Item"]
    assert item["title"]["S"] == "Sunset"
    assert item["is_public"]["BOOL"] is True
    assert item["is_public_str"]["S"] == "true"
    assert item["original_filename"]["S"] == "photo.jpg"
    assert item["original_key"]["S"] == key
    assert "created_at" in item
    assert item["variants"]["M"]["thumb"]["S"] == "processed/abc-123/thumb.webp"


def test_resize_strips_exif(aws):
    img = Image.new("RGB", (1000, 800), color=(50, 50, 50))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=b"Exif\x00\x00fake-exif-payload")
    key = "originals/xyz/photo.jpg"
    put_original(aws["s3"], key, buf.getvalue(), {"title": "T", "is-public": "false"})

    resize_main.handler(s3_event(key), None)

    out = aws["s3"].get_object(Bucket="test-bucket", Key="processed/xyz/thumb.webp")
    img_out = Image.open(io.BytesIO(out["Body"].read()))
    assert "exif" not in img_out.info


def test_resize_handles_private(aws):
    key = "originals/priv/photo.jpg"
    put_original(aws["s3"], key, make_jpeg_bytes(),
                 {"title": "Private", "is-public": "false"})

    resize_main.handler(s3_event(key), None)

    item = aws["ddb"].get_item(TableName="test-photos",
                               Key={"photo_id": {"S": "priv"}})["Item"]
    assert item["is_public"]["BOOL"] is False
    assert item["is_public_str"]["S"] == "false"
```

- [ ] **Step 2: Add `lambda/resize/__init__.py`** (empty file so the package imports)

```bash
touch lambda/resize/__init__.py
```

- [ ] **Step 3: Run the tests, confirm they fail**

```bash
cd lambda && source .venv/bin/activate && pytest resize/ -v
```
Expected: ImportError or ModuleNotFoundError for `main`.

### Task 15: Resize handler — implementation

**Files:**
- Create: `lambda/resize/main.py`

- [ ] **Step 1: Write `main.py`**

```python
import io
import os
import urllib.parse
from datetime import datetime, timezone

import boto3
from PIL import Image

s3 = boto3.client("s3")
ddb = boto3.client("dynamodb")

BUCKET = os.environ["BUCKET_NAME"]
TABLE = os.environ["PHOTOS_TABLE"]

SIZES = {"thumb": 400, "medium": 1200, "large": 2400}


def parse_photo_id_and_filename(key: str) -> tuple[str, str]:
    # key is originals/{photo_id}/{filename}
    parts = key.split("/", 2)
    if len(parts) != 3 or parts[0] != "originals":
        raise ValueError(f"unexpected key shape: {key}")
    return parts[1], parts[2]


def resize_to_webp(data: bytes, max_width: int) -> bytes:
    img = Image.open(io.BytesIO(data))
    img = img.convert("RGB")
    if img.width > max_width:
        h = int(img.height * (max_width / img.width))
        img = img.resize((max_width, h), Image.LANCZOS)
    buf = io.BytesIO()
    # exif explicitly NOT passed → stripped
    img.save(buf, format="WEBP", quality=85, method=6)
    return buf.getvalue()


def handler(event, _ctx):
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

    head = s3.head_object(Bucket=bucket, Key=key)
    metadata = head.get("Metadata", {})
    title = metadata.get("title", "")
    is_public = metadata.get("is-public", "false").lower() == "true"

    photo_id, filename = parse_photo_id_and_filename(key)
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()

    variants = {}
    for label, width in SIZES.items():
        out_key = f"processed/{photo_id}/{label}.webp"
        s3.put_object(
            Bucket=bucket,
            Key=out_key,
            Body=resize_to_webp(body, width),
            ContentType="image/webp",
            CacheControl="public, max-age=31536000, immutable",
        )
        variants[label] = {"S": out_key}

    ddb.put_item(
        TableName=TABLE,
        Item={
            "photo_id": {"S": photo_id},
            "title": {"S": title},
            "original_filename": {"S": filename},
            "original_key": {"S": key},
            "is_public": {"BOOL": is_public},
            "is_public_str": {"S": "true" if is_public else "false"},
            "created_at": {"S": datetime.now(timezone.utc).isoformat()},
            "variants": {"M": variants},
        },
    )
    return {"ok": True}
```

- [ ] **Step 2: Run tests, expect green**

```bash
cd lambda && pytest resize/ -v
```
Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
cd .. && git add lambda/resize/
git commit -m "feat(lambda): resize handler + tests (EXIF strip, 3 webp variants)"
```

### Task 16: Wire resize into Terraform + S3 event notification

**Files:**
- Create: `infra/aws/lambdas.tf` (partial — resize only for now)

- [ ] **Step 1: Write resize portion of `lambdas.tf`**

```hcl
data "archive_file" "resize" {
  type        = "zip"
  source_file = "${path.module}/lambda/resize/main.py"
  output_path = "${path.module}/resize.zip"
}

resource "aws_lambda_function" "resize" {
  function_name    = "${local.project}-resize"
  role             = aws_iam_role.resize.arn
  handler          = "main.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.resize.output_path
  source_code_hash = data.archive_file.resize.output_base64sha256
  timeout          = 60
  memory_size      = 1024
  layers           = [var.pillow_layer_arn]

  environment {
    variables = {
      BUCKET_NAME   = aws_s3_bucket.photos.id
      PHOTOS_TABLE  = aws_dynamodb_table.photos.name
    }
  }
}

resource "aws_cloudwatch_log_group" "resize" {
  name              = "/aws/lambda/${aws_lambda_function.resize.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "resize_s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.resize.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.photos.arn
}

resource "aws_s3_bucket_notification" "originals" {
  bucket = aws_s3_bucket.photos.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.resize.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "originals/"
  }

  depends_on = [aws_lambda_permission.resize_s3]
}
```

- [ ] **Step 2: Apply**

```bash
cd infra/aws && terraform apply
```
Type `yes`.

- [ ] **Step 3: Manual end-to-end test**

```bash
aws s3 cp /path/to/test.jpg "s3://$(terraform output -raw s3_bucket_name)/originals/manual-test-1/test.jpg" \
  --metadata title="Manual Test",is-public="true" \
  --content-type image/jpeg
```

Wait 5 seconds, then verify variants exist:
```bash
aws s3 ls "s3://$(terraform output -raw s3_bucket_name)/processed/manual-test-1/"
```
Expected: `large.webp`, `medium.webp`, `thumb.webp`.

Verify DDB row:
```bash
aws dynamodb get-item --table-name photos-photos \
  --key '{"photo_id":{"S":"manual-test-1"}}'
```
Expected: row with title, is_public, variants.

- [ ] **Step 4: Clean up test artifacts**

```bash
BUCKET=$(terraform output -raw s3_bucket_name)
aws s3 rm "s3://$BUCKET/originals/manual-test-1/" --recursive
aws s3 rm "s3://$BUCKET/processed/manual-test-1/" --recursive
aws dynamodb delete-item --table-name photos-photos --key '{"photo_id":{"S":"manual-test-1"}}'
```

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add infra/aws/lambdas.tf
git commit -m "feat(infra): wire resize lambda + S3 event trigger"
```

---

## Phase 5 — list_photos Lambda

### Task 17: list_photos — failing tests

**Files:**
- Create: `lambda/list_photos/__init__.py`
- Create: `lambda/list_photos/test_main.py`

- [ ] **Step 1: Empty `__init__.py`**

```bash
touch lambda/list_photos/__init__.py
```

- [ ] **Step 2: Write `test_main.py`**

```python
import json
import boto3
import pytest
from moto import mock_aws

from . import main as list_main


@pytest.fixture
def aws():
    with mock_aws():
        ddb = boto3.client("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="test-photos",
            KeySchema=[{"AttributeName": "photo_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "photo_id", "AttributeType": "S"},
                {"AttributeName": "is_public_str", "AttributeType": "S"},
                {"AttributeName": "created_at", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[{
                "IndexName": "public-index",
                "KeySchema": [
                    {"AttributeName": "is_public_str", "KeyType": "HASH"},
                    {"AttributeName": "created_at", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }],
            BillingMode="PAY_PER_REQUEST",
        )
        ddb.create_table(
            TableName="test-users",
            KeySchema=[{"AttributeName": "email", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "email", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )

        def put_photo(pid, public, ts, title="t"):
            ddb.put_item(TableName="test-photos", Item={
                "photo_id": {"S": pid},
                "title": {"S": title},
                "original_filename": {"S": f"{pid}.jpg"},
                "original_key": {"S": f"originals/{pid}/{pid}.jpg"},
                "is_public": {"BOOL": public},
                "is_public_str": {"S": "true" if public else "false"},
                "created_at": {"S": ts},
                "variants": {"M": {
                    "thumb":  {"S": f"processed/{pid}/thumb.webp"},
                    "medium": {"S": f"processed/{pid}/medium.webp"},
                    "large":  {"S": f"processed/{pid}/large.webp"},
                }},
            })

        put_photo("p1", True,  "2026-01-01T00:00:00Z", "Public 1")
        put_photo("p2", False, "2026-02-01T00:00:00Z", "Private 1")
        put_photo("p3", True,  "2026-03-01T00:00:00Z", "Public 2")

        ddb.put_item(TableName="test-users", Item={
            "email": {"S": "viewer@example.com"},
            "role":  {"S": "viewer"},
        })
        ddb.put_item(TableName="test-users", Item={
            "email": {"S": "admin@example.com"},
            "role":  {"S": "admin"},
        })

        yield ddb


def public_event():
    return {"requestContext": {}, "path": "/photos"}


def private_event(email):
    return {
        "requestContext": {
            "authorizer": {"claims": {"email": email}}
        },
        "path": "/photos/private",
    }


def parse(resp):
    return resp["statusCode"], json.loads(resp["body"])


def test_public_returns_only_public_photos(aws):
    code, body = parse(list_main.handler(public_event(), None))
    assert code == 200
    ids = [p["id"] for p in body["photos"]]
    assert set(ids) == {"p1", "p3"}


def test_public_sorted_desc_by_created_at(aws):
    code, body = parse(list_main.handler(public_event(), None))
    assert [p["id"] for p in body["photos"]] == ["p3", "p1"]


def test_public_urls_use_cloudfront_domain(aws):
    _, body = parse(list_main.handler(public_event(), None))
    assert body["photos"][0]["urls"]["thumb"].startswith("https://cdn.example.com/processed/")


def test_private_whitelisted_viewer_sees_all(aws):
    code, body = parse(list_main.handler(private_event("viewer@example.com"), None))
    assert code == 200
    assert {p["id"] for p in body["photos"]} == {"p1", "p2", "p3"}


def test_private_admin_sees_all(aws):
    code, body = parse(list_main.handler(private_event("admin@example.com"), None))
    assert code == 200
    assert {p["id"] for p in body["photos"]} == {"p1", "p2", "p3"}


def test_private_non_whitelisted_403(aws):
    code, body = parse(list_main.handler(private_event("rando@example.com"), None))
    assert code == 403


def test_private_email_lowercased_before_lookup(aws):
    code, body = parse(list_main.handler(private_event("VIEWER@Example.com"), None))
    assert code == 200
```

- [ ] **Step 3: Run, expect ImportError**

```bash
cd lambda && pytest list_photos/ -v
```
Expected: fails.

### Task 18: list_photos — implementation

**Files:**
- Create: `lambda/list_photos/main.py`

- [ ] **Step 1: Write `main.py`**

```python
import json
import os
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key

ddb = boto3.resource("dynamodb")
PHOTOS = ddb.Table(os.environ["PHOTOS_TABLE"])
USERS = ddb.Table(os.environ["USERS_TABLE"])
CDN = os.environ["CLOUDFRONT_DOMAIN"]

LIMIT = 60


def to_response(photos: list[dict]) -> dict:
    out = []
    for p in photos:
        variants = p.get("variants", {}) or {}
        out.append({
            "id": p["photo_id"],
            "title": p.get("title", ""),
            "isPublic": bool(p.get("is_public", False)),
            "createdAt": p.get("created_at"),
            "urls": {
                size: f"https://{CDN}/{variants[size]}"
                for size in ("thumb", "medium", "large")
                if size in variants
            },
        })
    return {"photos": out}


def query_public() -> list[dict]:
    resp = PHOTOS.query(
        IndexName="public-index",
        KeyConditionExpression=Key("is_public_str").eq("true"),
        ScanIndexForward=False,
        Limit=LIMIT,
    )
    return resp["Items"]


def scan_all() -> list[dict]:
    resp = PHOTOS.scan(Limit=LIMIT * 4)
    items = resp["Items"]
    items.sort(key=lambda i: i.get("created_at", ""), reverse=True)
    return items[:LIMIT]


def is_whitelisted(email: str) -> bool:
    item = USERS.get_item(Key={"email": email.lower()}).get("Item")
    if not item:
        return False
    return item.get("role") in {"viewer", "admin"}


def respond(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def handler(event, _ctx):
    claims = (event.get("requestContext", {})
              .get("authorizer", {})
              .get("claims") or {})
    email = claims.get("email")

    if email is None:
        return respond(200, to_response(query_public()))

    if not is_whitelisted(email):
        return respond(403, {"error": "not_whitelisted"})

    return respond(200, to_response(scan_all()))
```

- [ ] **Step 2: Run tests, expect green**

```bash
cd lambda && pytest list_photos/ -v
```
Expected: 7 passed.

- [ ] **Step 3: Commit**

```bash
cd .. && git add lambda/list_photos/
git commit -m "feat(lambda): list_photos handler + tests"
```

### Task 19: Wire list_photos + API Gateway routes

**Files:**
- Modify: `infra/aws/lambdas.tf`
- Create: `infra/aws/api_gateway.tf`

- [ ] **Step 1: Append list_photos block to `lambdas.tf`**

```hcl
data "archive_file" "list_photos" {
  type        = "zip"
  source_file = "${path.module}/lambda/list_photos/main.py"
  output_path = "${path.module}/list_photos.zip"
}

resource "aws_lambda_function" "list_photos" {
  function_name    = "${local.project}-list-photos"
  role             = aws_iam_role.list_photos.arn
  handler          = "main.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.list_photos.output_path
  source_code_hash = data.archive_file.list_photos.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      PHOTOS_TABLE      = aws_dynamodb_table.photos.name
      USERS_TABLE       = aws_dynamodb_table.users.name
      CLOUDFRONT_DOMAIN = var.cdn_domain
    }
  }
}

resource "aws_cloudwatch_log_group" "list_photos" {
  name              = "/aws/lambda/${aws_lambda_function.list_photos.function_name}"
  retention_in_days = 14
}
```

- [ ] **Step 2: Write `api_gateway.tf`**

```hcl
resource "aws_api_gateway_rest_api" "main" {
  name = "${local.project}-api"
}

resource "aws_api_gateway_authorizer" "cognito" {
  name          = "cognito"
  type          = "COGNITO_USER_POOLS"
  rest_api_id   = aws_api_gateway_rest_api.main.id
  provider_arns = [aws_cognito_user_pool.main.arn]
}

# /photos
resource "aws_api_gateway_resource" "photos" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "photos"
}

resource "aws_api_gateway_method" "photos_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.photos.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "photos_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.photos.id
  http_method             = aws_api_gateway_method.photos_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.list_photos.invoke_arn
}

# /photos/private
resource "aws_api_gateway_resource" "photos_private" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.photos.id
  path_part   = "private"
}

resource "aws_api_gateway_method" "photos_private_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.photos_private.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "photos_private_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.photos_private.id
  http_method             = aws_api_gateway_method.photos_private_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.list_photos.invoke_arn
}

# Lambda invoke permission for both routes
resource "aws_lambda_permission" "apigw_list_photos" {
  statement_id  = "AllowAPIGatewayInvokeListPhotos"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.list_photos.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# Deployment + stage (recreated when any route changes)
resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_method.photos_get.id,
      aws_api_gateway_integration.photos_get.id,
      aws_api_gateway_method.photos_private_get.id,
      aws_api_gateway_integration.photos_private_get.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  deployment_id = aws_api_gateway_deployment.main.id
  stage_name    = "prod"
}
```

- [ ] **Step 3: Add API URL to `outputs.tf`**

Append:
```hcl
output "api_gateway_url" {
  value = "${aws_api_gateway_stage.prod.invoke_url}"
}
```

- [ ] **Step 4: Apply**

```bash
cd infra/aws && terraform apply
```

- [ ] **Step 5: Curl test**

```bash
curl -s "$(terraform output -raw api_gateway_url)/photos" | jq
```
Expected: `{ "photos": [] }` (no photos yet). 200 status.

- [ ] **Step 6: Commit**

```bash
cd ../.. && git add infra/aws/
git commit -m "feat(infra): API Gateway + list_photos integration"
```

---

## Phase 6 — admin Lambda

### Task 20: admin handler — failing tests

**Files:**
- Create: `lambda/admin/__init__.py`
- Create: `lambda/admin/test_main.py`

- [ ] **Step 1: Empty `__init__.py`**

```bash
touch lambda/admin/__init__.py
```

- [ ] **Step 2: Write `test_main.py`**

```python
import json
import boto3
import pytest
from moto import mock_aws

from . import main as admin_main


@pytest.fixture
def aws():
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-bucket")
        ddb = boto3.client("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="test-photos",
            KeySchema=[{"AttributeName": "photo_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "photo_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        ddb.create_table(
            TableName="test-users",
            KeySchema=[{"AttributeName": "email", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "email", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        ddb.put_item(TableName="test-users", Item={
            "email": {"S": "admin@example.com"}, "role": {"S": "admin"}
        })
        ddb.put_item(TableName="test-users", Item={
            "email": {"S": "viewer@example.com"}, "role": {"S": "viewer"}
        })
        yield {"s3": s3, "ddb": ddb}


def event(method, path, email, body=None):
    return {
        "httpMethod": method,
        "path": path,
        "requestContext": {"authorizer": {"claims": {"email": email}}},
        "body": json.dumps(body) if body else None,
    }


def parse(resp):
    return resp["statusCode"], json.loads(resp["body"])


def test_presign_requires_admin_role(aws):
    code, _ = parse(admin_main.handler(event(
        "POST", "/admin/presign", "viewer@example.com",
        {"filename": "x.jpg", "contentType": "image/jpeg",
         "title": "t", "isPublic": True}
    ), None))
    assert code == 403


def test_presign_rejects_unknown_email(aws):
    code, _ = parse(admin_main.handler(event(
        "POST", "/admin/presign", "rando@example.com",
        {"filename": "x.jpg", "contentType": "image/jpeg",
         "title": "t", "isPublic": False}
    ), None))
    assert code == 403


def test_presign_rejects_disallowed_content_type(aws):
    code, _ = parse(admin_main.handler(event(
        "POST", "/admin/presign", "admin@example.com",
        {"filename": "x.gif", "contentType": "image/gif",
         "title": "t", "isPublic": False}
    ), None))
    assert code == 400


def test_presign_returns_url_fields_photoId(aws):
    code, body = parse(admin_main.handler(event(
        "POST", "/admin/presign", "admin@example.com",
        {"filename": "x.jpg", "contentType": "image/jpeg",
         "title": "Sunset", "isPublic": True}
    ), None))
    assert code == 200
    assert "url" in body
    assert "fields" in body
    assert "photoId" in body
    assert body["fields"]["x-amz-meta-title"] == "Sunset"
    assert body["fields"]["x-amz-meta-is-public"] == "true"
    assert body["fields"]["key"].startswith(f"originals/{body['photoId']}/x.jpg")


def test_delete_requires_admin(aws):
    code, _ = parse(admin_main.handler(event(
        "DELETE", "/admin/photo", "viewer@example.com",
        {"photoId": "abc"}
    ), None))
    assert code == 403


def test_delete_removes_s3_and_ddb(aws):
    pid = "abc"
    aws["s3"].put_object(Bucket="test-bucket", Key=f"originals/{pid}/f.jpg", Body=b"x")
    for size in ("thumb", "medium", "large"):
        aws["s3"].put_object(Bucket="test-bucket",
                             Key=f"processed/{pid}/{size}.webp", Body=b"x")
    aws["ddb"].put_item(TableName="test-photos", Item={
        "photo_id": {"S": pid},
        "original_key": {"S": f"originals/{pid}/f.jpg"},
        "variants": {"M": {
            "thumb":  {"S": f"processed/{pid}/thumb.webp"},
            "medium": {"S": f"processed/{pid}/medium.webp"},
            "large":  {"S": f"processed/{pid}/large.webp"},
        }},
    })

    code, _ = parse(admin_main.handler(event(
        "DELETE", "/admin/photo", "admin@example.com", {"photoId": pid}
    ), None))
    assert code == 200

    listed = aws["s3"].list_objects_v2(Bucket="test-bucket", Prefix=f"originals/{pid}/")
    assert "Contents" not in listed
    listed_p = aws["s3"].list_objects_v2(Bucket="test-bucket", Prefix=f"processed/{pid}/")
    assert "Contents" not in listed_p

    item = aws["ddb"].get_item(TableName="test-photos",
                               Key={"photo_id": {"S": pid}})
    assert "Item" not in item


def test_delete_missing_photo_returns_404(aws):
    code, _ = parse(admin_main.handler(event(
        "DELETE", "/admin/photo", "admin@example.com", {"photoId": "nope"}
    ), None))
    assert code == 404
```

- [ ] **Step 3: Run, expect failure**

```bash
cd lambda && pytest admin/ -v
```
Expected: ImportError.

### Task 21: admin handler — implementation

**Files:**
- Create: `lambda/admin/main.py`

- [ ] **Step 1: Write `main.py`**

```python
import json
import os
import uuid
from typing import Any

import boto3

s3 = boto3.client("s3")
ddb = boto3.resource("dynamodb")
PHOTOS = ddb.Table(os.environ["PHOTOS_TABLE"])
USERS = ddb.Table(os.environ["USERS_TABLE"])
BUCKET = os.environ["BUCKET_NAME"]

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_BYTES = 50 * 1024 * 1024


def respond(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def get_role(email: str) -> str | None:
    item = USERS.get_item(Key={"email": email.lower()}).get("Item")
    return item.get("role") if item else None


def require_admin(event) -> str | None:
    """Returns email if admin, else None (caller must short-circuit)."""
    claims = (event.get("requestContext", {})
              .get("authorizer", {})
              .get("claims") or {})
    email = claims.get("email")
    if not email:
        return None
    return email if get_role(email) == "admin" else None


def presign(event):
    body = json.loads(event["body"] or "{}")
    filename = body.get("filename")
    content_type = body.get("contentType")
    title = body.get("title", "")
    is_public = bool(body.get("isPublic", False))

    if content_type not in ALLOWED_TYPES:
        return respond(400, {"error": "unsupported_content_type"})
    if not filename:
        return respond(400, {"error": "filename_required"})

    photo_id = str(uuid.uuid4())
    key = f"originals/{photo_id}/{filename}"
    is_public_str = "true" if is_public else "false"

    presigned = s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=key,
        Fields={
            "Content-Type": content_type,
            "x-amz-meta-title": title,
            "x-amz-meta-is-public": is_public_str,
        },
        Conditions=[
            {"bucket": BUCKET},
            {"key": key},
            {"Content-Type": content_type},
            {"x-amz-meta-title": title},
            {"x-amz-meta-is-public": is_public_str},
            ["content-length-range", 0, MAX_BYTES],
        ],
        ExpiresIn=300,
    )
    return respond(200, {
        "url": presigned["url"],
        "fields": presigned["fields"],
        "photoId": photo_id,
    })


def delete_photo(event):
    body = json.loads(event["body"] or "{}")
    photo_id = body.get("photoId")
    if not photo_id:
        return respond(400, {"error": "photoId_required"})

    item = PHOTOS.get_item(Key={"photo_id": photo_id}).get("Item")
    if not item:
        return respond(404, {"error": "not_found"})

    keys = [item["original_key"]]
    for v in item.get("variants", {}).values():
        keys.append(v)

    # S3 first: only touch DDB if S3 succeeds.
    result = s3.delete_objects(
        Bucket=BUCKET,
        Delete={"Objects": [{"Key": k} for k in keys], "Quiet": False},
    )
    errors = result.get("Errors", [])
    if errors:
        # Single retry on the failed subset.
        failed_keys = [e["Key"] for e in errors]
        retry = s3.delete_objects(
            Bucket=BUCKET,
            Delete={"Objects": [{"Key": k} for k in failed_keys], "Quiet": False},
        )
        if retry.get("Errors"):
            return respond(500, {"error": "s3_delete_failed",
                                 "details": retry["Errors"]})

    PHOTOS.delete_item(Key={"photo_id": photo_id})
    return respond(200, {"deleted": photo_id})


def handler(event, _ctx):
    admin_email = require_admin(event)
    if not admin_email:
        return respond(403, {"error": "forbidden"})

    method = event.get("httpMethod")
    path = event.get("path", "")

    if method == "POST" and path.endswith("/admin/presign"):
        return presign(event)
    if method == "DELETE" and path.endswith("/admin/photo"):
        return delete_photo(event)

    return respond(404, {"error": "no_route"})
```

- [ ] **Step 2: Run tests**

```bash
cd lambda && pytest admin/ -v
```
Expected: 7 passed.

- [ ] **Step 3: Commit**

```bash
cd .. && git add lambda/admin/
git commit -m "feat(lambda): admin handler (presign + delete) + tests"
```

### Task 22: Wire admin + API Gateway routes

**Files:**
- Modify: `infra/aws/lambdas.tf`
- Modify: `infra/aws/api_gateway.tf`

- [ ] **Step 1: Append admin block to `lambdas.tf`**

```hcl
data "archive_file" "admin" {
  type        = "zip"
  source_file = "${path.module}/lambda/admin/main.py"
  output_path = "${path.module}/admin.zip"
}

resource "aws_lambda_function" "admin" {
  function_name    = "${local.project}-admin"
  role             = aws_iam_role.admin.arn
  handler          = "main.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.admin.output_path
  source_code_hash = data.archive_file.admin.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      BUCKET_NAME  = aws_s3_bucket.photos.id
      PHOTOS_TABLE = aws_dynamodb_table.photos.name
      USERS_TABLE  = aws_dynamodb_table.users.name
    }
  }
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = "/aws/lambda/${aws_lambda_function.admin.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_permission" "apigw_admin" {
  statement_id  = "AllowAPIGatewayInvokeAdmin"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}
```

- [ ] **Step 2: Append routes to `api_gateway.tf`**

```hcl
# /admin
resource "aws_api_gateway_resource" "admin" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "admin"
}

# /admin/presign
resource "aws_api_gateway_resource" "admin_presign" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "presign"
}

resource "aws_api_gateway_method" "admin_presign_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_presign.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_presign_post" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_presign.id
  http_method             = aws_api_gateway_method.admin_presign_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin.invoke_arn
}

# /admin/photo
resource "aws_api_gateway_resource" "admin_photo" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "photo"
}

resource "aws_api_gateway_method" "admin_photo_delete" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_photo.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_photo_delete" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_photo.id
  http_method             = aws_api_gateway_method.admin_photo_delete.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin.invoke_arn
}
```

- [ ] **Step 3: Update deployment trigger in `api_gateway.tf`**

Change the `triggers` block of `aws_api_gateway_deployment.main` to include the new methods/integrations:
```hcl
  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_method.photos_get.id,
      aws_api_gateway_integration.photos_get.id,
      aws_api_gateway_method.photos_private_get.id,
      aws_api_gateway_integration.photos_private_get.id,
      aws_api_gateway_method.admin_presign_post.id,
      aws_api_gateway_integration.admin_presign_post.id,
      aws_api_gateway_method.admin_photo_delete.id,
      aws_api_gateway_integration.admin_photo_delete.id,
    ]))
  }
```

- [ ] **Step 4: Apply**

```bash
cd infra/aws && terraform apply
```

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add infra/aws/
git commit -m "feat(infra): API Gateway admin routes + lambda"
```

---

## Phase 7 — Next.js scaffolding

### Task 23: `.env.local.example` + `next.config.ts` + global env helper

**Files:**
- Create: `.env.local.example`
- Modify: `next.config.ts` (whatever currently exists)
- Create: `lib/env.ts`

- [ ] **Step 1: `.env.local.example`**

```
# From `terraform output` (see infra/aws/outputs.tf)
COGNITO_DOMAIN=
COGNITO_CLIENT_ID=
COGNITO_REDIRECT_URI=http://localhost:3000/auth/callback
COGNITO_LOGOUT_URI=http://localhost:3000
API_GATEWAY_URL=
CLOUDFRONT_URL=https://cdn.photos.davidshubov.com
```

- [ ] **Step 2: Inspect current `next.config.ts`**

```bash
cat next.config.ts
```

- [ ] **Step 3: Update `next.config.ts` to add `images.remotePatterns`**

Replace contents with:
```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.photos.davidshubov.com",
      },
    ],
  },
};

export default nextConfig;
```

- [ ] **Step 4: Write `lib/env.ts`**

```typescript
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const env = {
  cognitoDomain: req("COGNITO_DOMAIN"),
  cognitoClientId: req("COGNITO_CLIENT_ID"),
  cognitoRedirectUri: req("COGNITO_REDIRECT_URI"),
  cognitoLogoutUri: req("COGNITO_LOGOUT_URI"),
  apiGatewayUrl: req("API_GATEWAY_URL"),
  cloudfrontUrl: req("CLOUDFRONT_URL"),
};
```

- [ ] **Step 5: Commit**

```bash
git add .env.local.example next.config.ts lib/env.ts
git commit -m "feat(web): env helper + CDN remotePattern + env example"
```

### Task 24: `lib/auth/pkce.ts` — PKCE + state generation

**Files:**
- Create: `lib/auth/pkce.ts`

- [ ] **Step 1: Write `pkce.ts`**

```typescript
import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function generateState(): string {
  return base64url(randomBytes(32));
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/auth/pkce.ts
git commit -m "feat(web): PKCE + state generation helpers"
```

### Task 25: `lib/auth/session.ts` — cookie + JWT decode helpers

**Files:**
- Create: `lib/auth/session.ts`

- [ ] **Step 1: Write `session.ts`**

```typescript
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
```

> **Next.js 16 note:** `cookies()` is async in Next.js 16. Verify by skimming `node_modules/next/dist/docs/` before relying on this shape; correct if needed.

- [ ] **Step 2: Commit**

```bash
git add lib/auth/session.ts
git commit -m "feat(web): session cookie + JWT claim helpers"
```

### Task 26: `lib/auth/cognito.ts` — token exchange + refresh

**Files:**
- Create: `lib/auth/cognito.ts`

- [ ] **Step 1: Write `cognito.ts`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add lib/auth/cognito.ts
git commit -m "feat(web): cognito token exchange + refresh helpers"
```

---

## Phase 8 — Auth routes + middleware

### Task 27: `/auth/login` route

**Files:**
- Create: `app/auth/login/route.ts`

- [ ] **Step 1: Write `route.ts`**

```typescript
import { NextResponse } from "next/server";
import { codeChallenge, generateCodeVerifier, generateState } from "@/lib/auth/pkce";
import { loginUrl } from "@/lib/auth/cognito";

export async function GET() {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = codeChallenge(verifier);

  const res = NextResponse.redirect(loginUrl(state, challenge));
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/auth/callback",
    maxAge: 600,
  };
  res.cookies.set("oauth_state", state, cookieOpts);
  res.cookies.set("pkce_verifier", verifier, cookieOpts);
  return res;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/auth/login/route.ts
git commit -m "feat(web): /auth/login with PKCE + state cookies"
```

### Task 28: `/auth/callback` route

**Files:**
- Create: `app/auth/callback/route.ts`

- [ ] **Step 1: Write `route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { exchangeAuthCode } from "@/lib/auth/cognito";
import { decodeJwtClaimsUnverified } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const storedState = req.cookies.get("oauth_state")?.value;
  const verifier = req.cookies.get("pkce_verifier")?.value;

  if (!code || !state || !storedState || state !== storedState || !verifier) {
    return NextResponse.json({ error: "invalid_state" }, { status: 400 });
  }

  const tokens = await exchangeAuthCode(code, verifier);
  const claims = decodeJwtClaimsUnverified(tokens.id_token);
  const idMaxAge = claims?.exp
    ? Math.max(0, claims.exp - Math.floor(Date.now() / 1000))
    : tokens.expires_in;

  const res = NextResponse.redirect(new URL("/", req.url));

  res.cookies.set("id_token", tokens.id_token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: idMaxAge,
  });

  if (tokens.refresh_token) {
    res.cookies.set("refresh_token", tokens.refresh_token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/auth/refresh",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  // Delete transient cookies — must repeat the original path or browsers ignore.
  const transient = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/auth/callback",
    maxAge: 0,
  };
  res.cookies.set("oauth_state", "", transient);
  res.cookies.set("pkce_verifier", "", transient);

  return res;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/auth/callback/route.ts
git commit -m "feat(web): /auth/callback with state verify + cookie set"
```

### Task 29: `/auth/logout` route

**Files:**
- Create: `app/auth/logout/route.ts`

- [ ] **Step 1: Write `route.ts`**

```typescript
import { NextResponse } from "next/server";
import { logoutUrl } from "@/lib/auth/cognito";

export async function GET() {
  const res = NextResponse.redirect(logoutUrl());
  res.cookies.set("id_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("refresh_token", "", { path: "/auth/refresh", maxAge: 0 });
  return res;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/auth/logout/route.ts
git commit -m "feat(web): /auth/logout clears cookies + redirects to cognito"
```

### Task 30: `/auth/refresh` route

**Files:**
- Create: `app/auth/refresh/route.ts`

- [ ] **Step 1: Write `route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { refreshIdToken } from "@/lib/auth/cognito";
import { decodeJwtClaimsUnverified } from "@/lib/auth/session";

function clearCookies(res: NextResponse) {
  res.cookies.set("id_token", "", { path: "/", maxAge: 0 });
  res.cookies.set("refresh_token", "", { path: "/auth/refresh", maxAge: 0 });
}

export async function POST(req: NextRequest) {
  const refresh = req.cookies.get("refresh_token")?.value;
  if (!refresh) {
    const res = NextResponse.json({ error: "no_refresh" }, { status: 401 });
    clearCookies(res);
    return res;
  }

  try {
    const tokens = await refreshIdToken(refresh);
    const claims = decodeJwtClaimsUnverified(tokens.id_token);
    const maxAge = claims?.exp
      ? Math.max(0, claims.exp - Math.floor(Date.now() / 1000))
      : tokens.expires_in;

    const res = new NextResponse(null, { status: 204 });
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
    const res = NextResponse.json({ error: "refresh_failed" }, { status: 401 });
    clearCookies(res);
    return res;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add app/auth/refresh/route.ts
git commit -m "feat(web): /auth/refresh route"
```

### Task 31: `middleware.ts` — preemptive refresh + admin guard

**Files:**
- Create: `middleware.ts`

- [ ] **Step 1: Write `middleware.ts`**

```typescript
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

export async function middleware(req: NextRequest) {
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
```

- [ ] **Step 2: Commit**

```bash
git add middleware.ts
git commit -m "feat(web): middleware preemptive refresh + admin guard"
```

---

## Phase 9 — API client + gallery

### Task 32: `lib/api/client.ts` — typed server-side fetch

**Files:**
- Create: `lib/api/client.ts`
- Create: `lib/api/types.ts`

- [ ] **Step 1: Write `types.ts`**

```typescript
export type Photo = {
  id: string;
  title: string;
  isPublic: boolean;
  createdAt: string;
  urls: { thumb: string; medium: string; large: string };
};

export type PhotosResponse = { photos: Photo[] };

export type PresignResponse = {
  url: string;
  fields: Record<string, string>;
  photoId: string;
};
```

- [ ] **Step 2: Write `client.ts`**

```typescript
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
```

- [ ] **Step 3: Commit**

```bash
git add lib/api/
git commit -m "feat(web): server-side API client + types"
```

### Task 33: `components/PhotoGrid/`

**Files:**
- Create: `components/PhotoGrid/index.tsx`
- Create: `components/PhotoGrid/PhotoGrid.tsx`
- Create: `components/PhotoGrid/PhotoGrid.module.css`

- [ ] **Step 1: `index.tsx`**

```typescript
export { PhotoGrid } from "./PhotoGrid";
```

- [ ] **Step 2: `PhotoGrid.tsx`**

```typescript
import Image from "next/image";
import type { Photo } from "@/lib/api/types";
import styles from "./PhotoGrid.module.css";

export function PhotoGrid({ photos }: { photos: Photo[] }) {
  if (photos.length === 0) {
    return <p className={styles.empty}>No photos yet.</p>;
  }
  return (
    <ul className={styles.grid}>
      {photos.map(p => (
        <li key={p.id} className={styles.cell}>
          <a href={p.urls.large} target="_blank" rel="noreferrer">
            <Image
              src={p.urls.medium}
              alt={p.title || p.id}
              width={1200}
              height={800}
              sizes="(max-width: 768px) 100vw, 33vw"
              className={styles.img}
            />
          </a>
          {p.title ? <p className={styles.title}>{p.title}</p> : null}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: `PhotoGrid.module.css`**

```css
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.cell { margin: 0; }
.img { width: 100%; height: auto; display: block; border-radius: 4px; }
.title { margin: 6px 0 0; font-size: 14px; color: #444; }
.empty { color: #666; }
```

- [ ] **Step 4: Commit**

```bash
git add components/PhotoGrid/
git commit -m "feat(web): PhotoGrid component"
```

### Task 34: `app/page.tsx` — public gallery

**Files:**
- Modify: `app/page.tsx`

- [ ] **Step 1: Replace contents**

```typescript
import { listPrivatePhotos, listPublicPhotos } from "@/lib/api/client";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { Photo } from "@/lib/api/types";

function merge(public_: Photo[], private_: Photo[]): Photo[] {
  const byId = new Map<string, Photo>();
  for (const p of public_) byId.set(p.id, p);
  for (const p of private_) byId.set(p.id, p);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export default async function HomePage() {
  const pub = await listPublicPhotos();
  const priv = await listPrivatePhotos();
  const privPhotos = "forbidden" in priv ? [] : priv.photos;

  const photos = merge(pub.photos, privPhotos);

  return (
    <main style={{ maxWidth: 1200, margin: "40px auto", padding: "0 16px" }}>
      <h1>Photos</h1>
      <PhotoGrid photos={photos} />
    </main>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/page.tsx
git commit -m "feat(web): public gallery page"
```

---

## Phase 10 — Admin UI

### Task 35: Admin role check helper

**Files:**
- Create: `lib/auth/roles.ts`

- [ ] **Step 1: Write `roles.ts`**

```typescript
import { env } from "@/lib/env";
import { getIdToken } from "./session";

// Checks admin role by calling /photos/private and inspecting whether the
// authenticated path returns 200 — but that only proves "whitelisted", not
// "admin". For admin we instead try a no-op presign-like call. Cleanest:
// expose a small /me route from the admin lambda. For v1 simplicity we attempt
// a HEAD-style check using a presign with invalid body and inspect 400 vs 403.
//
// Simpler in practice: add a tiny GET /admin/me route to the admin lambda that
// returns {role}. Task 36 wires it.

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
```

- [ ] **Step 2: Commit**

```bash
git add lib/auth/roles.ts
git commit -m "feat(web): admin role check via /admin/me"
```

### Task 36: Add `/admin/me` to admin Lambda + API Gateway

**Files:**
- Modify: `lambda/admin/main.py`
- Modify: `lambda/admin/test_main.py`
- Modify: `infra/aws/api_gateway.tf`

- [ ] **Step 1: Add test**

Append to `lambda/admin/test_main.py`:
```python
def test_me_returns_role_for_known_user(aws):
    code, body = parse(admin_main.handler(event(
        "GET", "/admin/me", "admin@example.com"
    ), None))
    assert code == 200
    assert body == {"role": "admin", "email": "admin@example.com"}


def test_me_viewer(aws):
    code, body = parse(admin_main.handler(event(
        "GET", "/admin/me", "viewer@example.com"
    ), None))
    assert code == 200
    assert body == {"role": "viewer", "email": "viewer@example.com"}


def test_me_unknown_403(aws):
    code, _ = parse(admin_main.handler(event(
        "GET", "/admin/me", "nope@example.com"
    ), None))
    assert code == 403
```

- [ ] **Step 2: Update handler routing in `lambda/admin/main.py`**

Replace `handler` function:
```python
def me(event):
    claims = (event.get("requestContext", {})
              .get("authorizer", {})
              .get("claims") or {})
    email = (claims.get("email") or "").lower()
    role = get_role(email)
    if role not in {"admin", "viewer"}:
        return respond(403, {"error": "forbidden"})
    return respond(200, {"role": role, "email": email})


def handler(event, _ctx):
    method = event.get("httpMethod")
    path = event.get("path", "")

    if method == "GET" and path.endswith("/admin/me"):
        return me(event)

    # Admin-only routes from here on.
    admin_email = require_admin(event)
    if not admin_email:
        return respond(403, {"error": "forbidden"})

    if method == "POST" and path.endswith("/admin/presign"):
        return presign(event)
    if method == "DELETE" and path.endswith("/admin/photo"):
        return delete_photo(event)

    return respond(404, {"error": "no_route"})
```

- [ ] **Step 3: Run tests**

```bash
cd lambda && pytest admin/ -v
```
Expected: all admin tests pass (10 total).

- [ ] **Step 4: Add `/admin/me` to `api_gateway.tf`**

```hcl
resource "aws_api_gateway_resource" "admin_me" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.admin.id
  path_part   = "me"
}

resource "aws_api_gateway_method" "admin_me_get" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.admin_me.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "admin_me_get" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.admin_me.id
  http_method             = aws_api_gateway_method.admin_me_get.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.admin.invoke_arn
}
```

Append to the deployment `triggers`:
```hcl
      aws_api_gateway_method.admin_me_get.id,
      aws_api_gateway_integration.admin_me_get.id,
```

- [ ] **Step 5: Apply + commit**

```bash
cd ../.. && cd infra/aws && terraform apply && cd ../..
git add lambda/admin/ infra/aws/api_gateway.tf
git commit -m "feat: /admin/me route returns role"
```

### Task 37: `components/AdminUpload/`

**Files:**
- Create: `components/AdminUpload/index.tsx`
- Create: `components/AdminUpload/AdminUpload.tsx`
- Create: `components/AdminUpload/AdminUpload.module.css`

- [ ] **Step 1: `index.tsx`**

```typescript
export { AdminUpload } from "./AdminUpload";
```

- [ ] **Step 2: `AdminUpload.tsx`**

```typescript
"use client";

import { useState } from "react";
import styles from "./AdminUpload.module.css";

const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

export function AdminUpload({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [status, setStatus] = useState<string>("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      setStatus("Unsupported file type. Use JPEG, PNG, or WebP.");
      return;
    }
    setStatus("Requesting upload URL…");

    const presignRes = await fetch("/api/admin/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        title,
        isPublic,
      }),
    });
    if (!presignRes.ok) {
      setStatus(`Presign failed: ${presignRes.status}`);
      return;
    }
    const { url, fields, photoId } = await presignRes.json();

    setStatus("Uploading…");
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v as string);
    form.append("file", file);

    const upload = await fetch(url, { method: "POST", body: form });
    if (!upload.ok) {
      setStatus(`Upload failed: ${upload.status}`);
      return;
    }

    setStatus("Processing…");
    const start = Date.now();
    const deadline = start + 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
      const list = await fetch("/api/admin/photos").then(r => r.json());
      if (list.photos?.some((p: { id: string }) => p.id === photoId)) {
        setStatus("Done.");
        setFile(null); setTitle(""); setIsPublic(false);
        onUploaded();
        return;
      }
      setStatus(`Processing (${Math.round((Date.now() - start) / 1000)}s)…`);
    }
    setStatus("Still processing — refresh later.");
  }

  return (
    <form onSubmit={submit} className={styles.form}>
      <label className={styles.row}>
        Title:
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
               required />
      </label>
      <label className={styles.row}>
        <input type="checkbox" checked={isPublic}
               onChange={e => setIsPublic(e.target.checked)} />
        Public
      </label>
      <input type="file" accept={ALLOWED.join(",")}
             onChange={e => setFile(e.target.files?.[0] ?? null)} required />
      <button type="submit" disabled={!file}>Upload</button>
      {status ? <p className={styles.status}>{status}</p> : null}
    </form>
  );
}
```

- [ ] **Step 3: `AdminUpload.module.css`**

```css
.form { display: flex; flex-direction: column; gap: 12px; max-width: 400px; }
.row { display: flex; gap: 8px; align-items: center; }
.status { font-size: 14px; color: #555; }
```

- [ ] **Step 4: Commit**

```bash
git add components/AdminUpload/
git commit -m "feat(web): AdminUpload component"
```

### Task 38: BFF proxies for admin (so client doesn't expose API Gateway URL or attach tokens directly)

**Files:**
- Create: `app/api/admin/presign/route.ts`
- Create: `app/api/admin/photos/route.ts`
- Create: `app/api/admin/photo/route.ts`

- [ ] **Step 1: `app/api/admin/presign/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { adminPresign } from "@/lib/api/client";

export async function POST(req: NextRequest) {
  const body = await req.json();
  try {
    return NextResponse.json(await adminPresign(body));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 2: `app/api/admin/photos/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { listPrivatePhotos } from "@/lib/api/client";

export async function GET() {
  const r = await listPrivatePhotos();
  if ("forbidden" in r) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(r);
}
```

- [ ] **Step 3: `app/api/admin/photo/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { adminDelete } from "@/lib/api/client";

export async function DELETE(req: NextRequest) {
  const { photoId } = await req.json();
  try {
    return NextResponse.json(await adminDelete(photoId));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/
git commit -m "feat(web): BFF proxies for admin routes"
```

### Task 39: `components/AdminPhotoList/`

**Files:**
- Create: `components/AdminPhotoList/index.tsx`
- Create: `components/AdminPhotoList/AdminPhotoList.tsx`
- Create: `components/AdminPhotoList/AdminPhotoList.module.css`

- [ ] **Step 1: `index.tsx`**

```typescript
export { AdminPhotoList } from "./AdminPhotoList";
```

- [ ] **Step 2: `AdminPhotoList.tsx`**

```typescript
"use client";

import { useEffect, useState } from "react";
import type { Photo } from "@/lib/api/types";
import styles from "./AdminPhotoList.module.css";

export function AdminPhotoList({ refreshSignal }: { refreshSignal: number }) {
  const [photos, setPhotos] = useState<Photo[]>([]);

  async function load() {
    const res = await fetch("/api/admin/photos", { cache: "no-store" });
    if (res.ok) setPhotos((await res.json()).photos);
  }

  useEffect(() => { void load(); }, [refreshSignal]);

  async function del(id: string) {
    if (!confirm(`Delete ${id}?`)) return;
    const res = await fetch("/api/admin/photo", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoId: id }),
    });
    if (res.ok) await load();
  }

  return (
    <ul className={styles.list}>
      {photos.map(p => (
        <li key={p.id} className={styles.row}>
          <img src={p.urls.thumb} alt={p.title} width={80} />
          <span>{p.title}</span>
          <span>{p.isPublic ? "public" : "private"}</span>
          <button onClick={() => del(p.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: `AdminPhotoList.module.css`**

```css
.list { list-style: none; padding: 0; margin: 0; }
.row {
  display: grid; grid-template-columns: 80px 1fr auto auto;
  gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid #eee;
}
```

- [ ] **Step 4: Commit**

```bash
git add components/AdminPhotoList/
git commit -m "feat(web): AdminPhotoList component"
```

### Task 40: `app/admin/page.tsx` — role-guarded admin page

**Files:**
- Create: `app/admin/page.tsx`
- Create: `app/admin/AdminPage.tsx`

- [ ] **Step 1: `app/admin/page.tsx` (server, role check)**

```typescript
import { redirect } from "next/navigation";
import { getCurrentRole } from "@/lib/auth/roles";
import { AdminPage } from "./AdminPage";

export default async function Page() {
  const role = await getCurrentRole();
  if (role !== "admin") redirect("/");
  return <AdminPage />;
}
```

- [ ] **Step 2: `app/admin/AdminPage.tsx` (client, owns state)**

```typescript
"use client";

import { useState } from "react";
import { AdminUpload } from "@/components/AdminUpload";
import { AdminPhotoList } from "@/components/AdminPhotoList";

export function AdminPage() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: "0 16px" }}>
      <h1>Admin</h1>
      <section>
        <h2>Upload</h2>
        <AdminUpload onUploaded={() => setRefreshSignal(n => n + 1)} />
      </section>
      <section>
        <h2>Photos</h2>
        <AdminPhotoList refreshSignal={refreshSignal} />
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/admin/
git commit -m "feat(web): admin page with role guard + upload + list"
```

---

## Phase 11 — Scripts + deploy

### Task 41: `scripts/deploy.sh`

**Files:**
- Create: `scripts/deploy.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../infra/aws"

terraform apply

echo
echo "=== Vercel env vars to set ==="
echo "COGNITO_DOMAIN=$(terraform output -raw cognito_pool_domain)"
echo "COGNITO_CLIENT_ID=$(terraform output -raw cognito_client_id)"
echo "COGNITO_REDIRECT_URI=https://photos.davidshubov.com/auth/callback"
echo "COGNITO_LOGOUT_URI=https://photos.davidshubov.com"
echo "API_GATEWAY_URL=$(terraform output -raw api_gateway_url)"
echo "CLOUDFRONT_URL=https://$(terraform output -raw cdn_domain)"
echo
echo "=== DNS to add manually in Vercel ==="
echo "ACM validation CNAMEs:"
terraform output -json acm_validation_cnames | jq -r '.[] | "  \(.name) -> \(.value)"'
echo "CDN CNAME:"
echo "  $(terraform output -raw cdn_domain) -> $(terraform output -raw cloudfront_distribution_domain)"
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/deploy.sh
git add scripts/deploy.sh
git commit -m "feat(scripts): deploy.sh"
```

### Task 42: `scripts/teardown.sh`

**Files:**
- Create: `scripts/teardown.sh`

- [ ] **Step 1: Write + chmod + commit**

```bash
cat > scripts/teardown.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../infra/aws"
terraform destroy
EOF
chmod +x scripts/teardown.sh
git add scripts/teardown.sh
git commit -m "feat(scripts): teardown.sh"
```

### Task 43: `scripts/reconcile.py`

**Files:**
- Create: `scripts/reconcile.py`

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""Manual orphan reconciliation between DDB and S3.

Usage:
  python scripts/reconcile.py [--apply]

Without --apply it only prints orphans.
"""
import argparse
import json
import os
import subprocess
import sys

import boto3


def tf_out(name: str) -> str:
    return subprocess.check_output(
        ["terraform", "output", "-raw", name],
        cwd=os.path.join(os.path.dirname(__file__), "..", "infra", "aws"),
    ).decode().strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    bucket = tf_out("s3_bucket_name")
    s3 = boto3.client("s3")
    ddb = boto3.client("dynamodb")
    table = "photos-photos"

    # All DDB photo_ids
    ddb_ids: set[str] = set()
    paginator = ddb.get_paginator("scan")
    for page in paginator.paginate(TableName=table, ProjectionExpression="photo_id"):
        for item in page["Items"]:
            ddb_ids.add(item["photo_id"]["S"])

    # All S3 photo_ids (from originals/ and processed/ key prefixes)
    s3_ids: set[str] = set()
    for prefix in ("originals/", "processed/"):
        for page in s3.get_paginator("list_objects_v2").paginate(
            Bucket=bucket, Prefix=prefix
        ):
            for obj in page.get("Contents", []):
                parts = obj["Key"].split("/", 2)
                if len(parts) >= 2:
                    s3_ids.add(parts[1])

    ddb_only = sorted(ddb_ids - s3_ids)
    s3_only = sorted(s3_ids - ddb_ids)

    print(f"DDB rows with no S3 keys: {len(ddb_only)}")
    for pid in ddb_only:
        print(f"  {pid}")
    print(f"S3 keys with no DDB row: {len(s3_only)}")
    for pid in s3_only:
        print(f"  {pid}")

    if not args.apply:
        return

    if not (ddb_only or s3_only):
        return
    confirm = input("Apply deletes? [y/N] ").strip().lower()
    if confirm != "y":
        return

    for pid in ddb_only:
        ddb.delete_item(TableName=table, Key={"photo_id": {"S": pid}})
        print(f"deleted DDB {pid}")

    for pid in s3_only:
        for prefix in ("originals/", "processed/"):
            objs = s3.list_objects_v2(Bucket=bucket, Prefix=f"{prefix}{pid}/").get("Contents", [])
            if objs:
                s3.delete_objects(
                    Bucket=bucket,
                    Delete={"Objects": [{"Key": o["Key"]} for o in objs]},
                )
        print(f"deleted S3 {pid}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/reconcile.py
git add scripts/reconcile.py
git commit -m "feat(scripts): manual orphan reconciliation"
```

### Task 44: Vercel deployment + DNS

**Files:** none

This step is operational — performed in the Vercel dashboard, not in code.

- [ ] **Step 1: Push the repo to GitHub (if not already)**, link the Next.js project to Vercel.

- [ ] **Step 2: In the Vercel project settings → Environment Variables**, copy each variable printed by `scripts/deploy.sh` into Production *and* Preview scopes.

- [ ] **Step 3: In Vercel Domains**, add `photos.davidshubov.com` (Vercel manages the root `davidshubov.com`; assigning a subdomain is one click).

- [ ] **Step 4: Confirm CDN + ACM CNAMEs were already added during Task 11**. If not, add them now.

- [ ] **Step 5: Trigger a deploy. Visit `https://photos.davidshubov.com`. Expect the empty gallery page (no photos yet).**

- [ ] **Step 6: Sign in via `/auth/login` (only the admin email will reach `/admin`). Confirm round-trip works.**

---

## Phase 12 — Verification

### Task 45: Run the verification checklist

**Files:** none

Run each item from the spec's "Verification checklist". For each, capture either a curl, a screenshot, or a CloudWatch log line as evidence.

- [ ] Anonymous: `curl https://photos.davidshubov.com/` returns HTML containing only public photo IDs (check `data-photo-id` or inspect the rendered grid).
- [ ] Non-whitelisted signed-in user: temporarily add a non-admin Google account; sign in; confirm public set rendered and no error.
- [ ] Whitelisted viewer: add a row to `users` table with `role = viewer`; sign in with that account; confirm private photos appear.
- [ ] Admin upload: upload a JPEG via `/admin`; photo appears within 60s.
- [ ] Admin delete: delete the just-uploaded photo; row + S3 keys gone (verify with `aws s3 ls` and `aws dynamodb get-item`).
- [ ] Originals private: `curl https://cdn.photos.davidshubov.com/originals/<pid>/<file>` returns 403.
- [ ] EXIF stripped: download a processed variant and run `exiftool` — should show no EXIF except `ImageWidth`/`ImageHeight`.
- [ ] httpOnly cookies: open browser devtools → Application → Cookies. Confirm `id_token` and `refresh_token` are `HttpOnly` + `Secure`.
- [ ] `/admin` access: sign out, hit `/admin`, expect redirect to `/auth/login`. Sign in as viewer, hit `/admin`, expect redirect to `/`.
- [ ] Token expiry refresh: in devtools, manually edit `id_token` cookie to one that expires in 30 seconds (or use Cognito short token TTL); navigate; confirm cookie is replaced and no redirect.
- [ ] OAuth state mismatch: manually alter the `state` cookie value during the auth flow; expect 400 on `/auth/callback`.
- [ ] PKCE verifier required: delete `pkce_verifier` cookie before callback; expect 400.
- [ ] Reconcile script: manually `aws dynamodb delete-item` one row, then `python scripts/reconcile.py` — expect that row reported as S3-only orphan.

- [ ] **Step 1: Commit a checklist record**

Create `docs/superpowers/verifications/2026-06-XX-photo-subdomain.md` documenting which steps passed and capturing evidence references.

```bash
git add docs/superpowers/verifications/
git commit -m "docs: photo subdomain verification record"
```

---

## Self-review notes

The plan covers every spec requirement:

- Auth identity, PKCE/state, four-cookie scheme, refresh: Tasks 24, 27–31.
- Role storage + admin seeding: Tasks 4, 12, 18, 21.
- S3 + CloudFront OAC + cdn domain: Tasks 3, 9, 10, 11.
- DynamoDB schema + GSI: Task 4.
- API Gateway split paths: Tasks 19, 22, 36.
- Three Lambdas: Tasks 14–16, 17–19, 20–22.
- Frontend gallery, admin, middleware: Tasks 33–40.
- Scripts: Tasks 41–43.
- Verification: Task 45.

Known follow-ups not in this plan (intentionally — listed as out-of-scope in the spec): HEIC ingest, manual ordering, cursor pagination wiring (the API can be extended without breaking changes), per-photo ACL beyond `is_public`.
