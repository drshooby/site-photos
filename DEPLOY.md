# Deploy runbook — photos.davidshubov.com

Step-by-step to bring this site up from a clean slate, plus teardown. Read this end-to-end before starting; some steps gate on others completing (especially DNS/ACM).

## Prerequisites

- **AWS account** with admin (or at minimum: IAM, S3, DynamoDB, Lambda, CloudFront, ACM, API Gateway, Cognito).
- **Cloudflare account** with `davidshubov.com` (or your apex) as an active zone. Grey-cloud (DNS only) for every record this runbook adds — Cloudflare proxy will fight CloudFront and Vercel.
- **Vercel account** with this repo importable.
- **Google Cloud Console** project (for Google OAuth).
- **Local tools:**
  - `terraform >= 1.5`
  - `aws` CLI configured (`aws configure`) with credentials in the same account
  - `bun` (or `npm`/`pnpm`)
  - `dig`, `curl`, `python3`

---

## 1. Google OAuth client

Cognito federates to Google, so Google needs an OAuth client.

1. Open <https://console.cloud.google.com/apis/credentials>.
2. **Create credentials → OAuth client ID → Web application.** Name it anything.
3. Leave **Authorized JavaScript origins** empty (the app never calls Google from the browser).
4. Leave **Authorized redirect URIs** empty for now. You'll add the Cognito URI in step 4.
5. Save the **Client ID** and **Client secret**.

---

## 2. Terraform variables

```bash
cd infra/aws
```

Look up the latest Klayers Pillow ARN for Python 3.12 in `us-east-1`:

```bash
curl -s https://api.klayers.cloud/api/v2/p3.12/layers/latest/us-east-1/json/Pillow \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['arn'])"
```

Create `infra/aws/terraform.tfvars` (gitignored — never commit):

```hcl
google_auth_client_id     = "<step 1 client id>"
google_auth_client_secret = "<step 1 client secret>"
pillow_layer_arn          = "<arn from curl above>"
```

The other variables in `variables.tf` have sensible defaults (`region = us-east-1`, `cdn_domain = cdn.photos.davidshubov.com`, `site_domain = photos.davidshubov.com`, `admin_email = david.shubov@gmail.com`). Override them in tfvars if you forked.

---

## 3. First terraform apply

```bash
terraform init
terraform apply
```

Expect:
- S3 bucket, DynamoDB tables, Cognito user pool + Google IdP, Lambdas, API Gateway → all create.
- ACM cert → creates but enters `PENDING_VALIDATION` (resolved in step 5).
- **CloudFront distribution → fails** with `InvalidViewerCertificate`. This is expected — CloudFront refuses to attach an unvalidated cert. We'll come back after ACM is `ISSUED`.

The CloudFront failure does **not** roll back the other resources. Proceed.

---

## 4. Google OAuth redirect URI

Now that Cognito's hosted-UI domain exists:

```bash
terraform output -raw cognito_pool_domain
```

Back in Google Cloud Console → your OAuth client → **Authorized redirect URIs**, add:

```
https://<that-domain>/oauth2/idpresponse
```

Save. (This is the Cognito callback URL, not the app's. Google never sees `photos.davidshubov.com`.)

---

## 5. ACM validation via Cloudflare DNS

```bash
terraform output acm_validation_cnames
```

You'll get one or more `{ name, value }` pairs. In Cloudflare DNS for `davidshubov.com`:

- **Type:** CNAME
- **Name:** the `name` field (strip the trailing dot if Cloudflare complains; you can paste the full FQDN or the subdomain prefix — Cloudflare normalizes either)
- **Target:** the `value` field (strip trailing dot)
- **Proxy status:** **DNS only (grey cloud)**. Orange-cloud mangles the validation token.
- **TTL:** Auto

### CAA pitfall

ACM validates by climbing the DNS tree looking for CAA records. If any ancestor of `cdn.photos.davidshubov.com` has CAA records that don't include `amazon.com`, validation fails with `CAA_ERROR`.

The trap: if `photos.davidshubov.com` is a CNAME to Vercel (`*.vercel-dns-*.com`), Vercel publishes its own CAA records on that target whitelisting GlobalSign / Let's Encrypt / Google / Sectigo — **not Amazon**. ACM follows the CNAME and rejects.

**Workaround:** delete the `photos` CNAME in Cloudflare before this step. Re-add it in step 8 pointing at `cname.vercel-dns.com` (a generic Vercel host that doesn't carry the project-specific CAA records).

Verify CAA is clear before waiting on ACM:

```bash
for n in davidshubov.com photos.davidshubov.com cdn.photos.davidshubov.com; do
  echo "=== $n ===";
  dig $n CAA @1.1.1.1 +noall +answer
done
```

All three should be empty.

### Poll for ISSUED

```bash
until aws acm describe-certificate \
  --region us-east-1 \
  --certificate-arn $(cd infra/aws && terraform output -raw acm_certificate_arn) \
  --query 'Certificate.Status' --output text \
  | tee /dev/stderr | grep -q ISSUED; do
  sleep 30
done
```

Usually 1–5 min with Cloudflare. If it flips to `FAILED`, the cert is dead (terminal state). Recreate:

```bash
terraform taint aws_acm_certificate.cdn
terraform apply
```

…then redo the CNAMEs (hash stays the same per domain, so they should match — but verify).

---

## 6. Second terraform apply — CloudFront

```bash
terraform apply
```

CloudFront creates this time (~5–10 min to deploy globally).

Sanity check the CDN serves objects (will 403 until you upload any, that's fine):

```bash
curl -sI https://$(terraform output -raw cloudfront_distribution_domain)/
```

---

## 7. CDN CNAME in Cloudflare

```bash
terraform output -raw cloudfront_distribution_domain
```

In Cloudflare DNS:
- **Type:** CNAME
- **Name:** `cdn.photos`
- **Target:** that `.cloudfront.net` host
- **Proxy:** DNS only (grey cloud) — CloudFront has its own cert; proxying would terminate TLS at Cloudflare's edge and break.

Verify:

```bash
dig cdn.photos.davidshubov.com CNAME +short
curl -sI https://cdn.photos.davidshubov.com/
```

The `curl` should hit CloudFront (you'll see `server: AmazonS3` and `via: ... cloudfront.net` in the headers; a 403 with no key in the path is expected and means CloudFront is serving you).

---

## 8. Vercel project

Push the repo to GitHub if it isn't already, then:

1. Vercel → **Add New → Project → Import** the repo. Framework auto-detects Next.js.
2. **Settings → Environment Variables.** Add to both Production and Preview:

   ```
   COGNITO_DOMAIN              = <terraform output cognito_pool_domain>
   COGNITO_CLIENT_ID           = <terraform output cognito_client_id>
   COGNITO_REDIRECT_URI        = https://photos.davidshubov.com/auth/callback
   COGNITO_LOGOUT_URI          = https://photos.davidshubov.com
   API_GATEWAY_URL             = <terraform output api_gateway_url>
   CLOUDFRONT_URL              = https://cdn.photos.davidshubov.com
   ```

   `CLOUDFRONT_URL` is a static string — it doesn't depend on the CloudFront distribution existing yet, which lets you set env vars before step 6 is fully done if needed.

3. **Settings → Domains → Add** `photos.davidshubov.com`. Vercel will detect external NS and show a CNAME target — usually `cname.vercel-dns.com`.

4. In Cloudflare, add:
   - **Type:** CNAME
   - **Name:** `photos`
   - **Target:** `cname.vercel-dns.com`
   - **Proxy:** DNS only (grey cloud)

5. Trigger a deploy (push to `main` or hit Redeploy). Vercel should report the domain as "Valid Configuration" within a minute.

---

## 9. Smoke test

- `https://photos.davidshubov.com` → empty gallery ("No photographs yet.").
- Click **Sign in** → Google → land back on `/` with your email shown in the header (top-right).
- The role should show `admin` (the seed in `infra/aws/dynamodb.tf` writes `david.shubov@gmail.com` as admin). Click `admin` to enter `/admin`.
- Upload a JPEG. Photo appears within ~60s (resize Lambda runs on the S3 trigger).
- Click delete on the photo. S3 originals + processed variants + DDB row all clear.
- Sign out → header reverts, `/admin` redirects to `/`.

---

## 10. Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `terraform apply` complains a variable is required | Missing `terraform.tfvars` | Step 2. |
| `InvalidViewerCertificate` from CloudFront | ACM still `PENDING_VALIDATION` | Step 5; rerun apply once `ISSUED`. |
| ACM `CAA_ERROR` | Parent domain CNAMEs to a Vercel project-specific host that publishes CAA records excluding Amazon | Step 5, "CAA pitfall." Delete the stale `photos` CNAME, taint and re-apply ACM. |
| `/auth/callback` returns `{"error":"invalid_state"}` | `<Link>` to `/auth/login` did an RSC fetch (`?_rsc=` query) instead of a real navigation, so the state cookie was never set in the browser | All auth-route links must be plain `<a href>`, not Next `<Link>`. The code already does this in `components/SiteHeader`; if you add new auth links elsewhere, keep them as `<a>`. |
| Photos render but lay out as black boxes / weird spacing | `next/image` `remotePatterns` missing the CDN host, or you stored an image without `width`/`height` in DDB | Confirm `next.config.ts` has `cdn.photos.davidshubov.com` in `images.remotePatterns`. Old DDB rows have a 1200×800 fallback in `list_photos`; re-upload affected photos to get true dimensions. |
| Upload presign succeeds but the browser's `POST` to S3 returns `AccessDenied` | One of the presign POST conditions doesn't match (empty `title`, exotic filename, etc.) | Open DevTools → Network → response XML on the failed POST. It names the offending field. |
| Logged-in user gets bounced through Cognito again before token expiry | Pre-fix: `refresh_token` cookie was scoped to `/auth/refresh`, so the proxy couldn't read it on `/admin` requests. Already fixed; `refresh_token` is now path `/`. | n/a — fix is already in `proxy.ts` and `app/auth/callback/route.ts`. |

---

## 11. Teardown

```bash
cd infra/aws
terraform destroy
```

Things to know:

- The S3 bucket has `force_destroy = false`. If it has any objects, `terraform destroy` will fail on the bucket. Either empty it first (`aws s3 rm s3://<bucket> --recursive`) or flip `force_destroy = true` in `s3.tf` and re-apply once before destroying.
- CloudFront takes 5–15 min to fully delete (disabled first, then removed).
- Cognito user pool deletion drops all user records. The `users` DDB table seed (the admin email) is destroyed too.
- ACM cert is freed.

After Terraform finishes:

- **Cloudflare DNS:** remove the records you added in steps 5, 7, 8 (`_…cdn.photos` ACM validation CNAME, `cdn.photos`, `photos`).
- **Vercel:** remove `photos.davidshubov.com` from the project, optionally delete the project.
- **Google Cloud:** the OAuth client can stay parked or be deleted.

---

## 12. Things deliberately not built

- HEIC ingest (drop / convert on Mac before upload).
- Cursor-based pagination (hard cap of 60 photos returned).
- Background reconciliation of S3 vs DDB (`scripts/reconcile.py` is manual).
- Manual photo ordering / curation.
- Multi-region failover.
- Image upload progress beyond the elapsed-seconds counter.

---

## Reference

- Design spec: [`docs/superpowers/specs/2026-06-02-photo-subdomain-design.md`](docs/superpowers/specs/2026-06-02-photo-subdomain-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-02-photo-subdomain.md`](docs/superpowers/plans/2026-06-02-photo-subdomain.md)
- Codebase conventions: [`CLAUDE.md`](CLAUDE.md)
