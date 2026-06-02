# Manual deploy steps — photo subdomain

All code is committed on `main` (commits `006ca5d`…`47a149e`). The remaining work needs your AWS credentials, Google account, and Vercel dashboard access — nothing the implementation agents could do.

Follow the steps in order. Each numbered section is a separate human action; the bullets under it are what you actually do.

---

## 1. Google Cloud — create the OAuth client

Cognito's Google IdP needs a Google OAuth client. If you already have one, skip ahead and reuse it.

- Open https://console.cloud.google.com/apis/credentials in a project of your choice.
- **Create credentials → OAuth client ID → Web application.**
- Name: `photos-davidshubov-com` (or anything).
- **Authorized redirect URIs** — leave blank for now. We'll come back after Cognito is provisioned (step 3).
- Copy the **Client ID** and **Client secret**. Stash them — you'll need them in step 2.

---

## 2. Terraform — first apply (S3, DynamoDB, Cognito)

The Terraform code lives in `infra/aws/`. You need AWS credentials with permission to create the resources in `iam.tf`, `s3.tf`, `dynamodb.tf`, `cognito.tf`, `acm.tf`, `cloudfront.tf`, `api_gateway.tf`, `lambdas.tf`.

```bash
cd infra/aws
```

Look up the current Klayers Pillow ARN for Python 3.12 in us-east-1:

```bash
curl -s https://api.klayers.cloud/api/v2/p3.12/layers/latest/us-east-1/json/Pillow | python3 -c "import sys,json; print(json.load(sys.stdin)['arn'])"
```

Create `infra/aws/terraform.tfvars` (gitignored — never commit):

```hcl
google_auth_client_id     = "<from step 1>"
google_auth_client_secret = "<from step 1>"
pillow_layer_arn          = "<from the curl above>"
```

Now apply:

```bash
terraform init
terraform apply
```

Type `yes`. This first apply will provision everything except the CloudFront distribution (it needs a validated ACM cert, which depends on a manual DNS step in step 4).

Expect ACM to show as `PENDING_VALIDATION`. That's fine; CloudFront's `apply` will block waiting for it, which is what step 4 resolves.

---

## 3. Google Cloud — add the Cognito redirect URI

Now that Cognito exists, get its hosted-UI domain:

```bash
terraform output -raw cognito_pool_domain
```

Back in Google Cloud Console → your OAuth client → **Authorized redirect URIs**, add:

```
https://<that-pool-domain>/oauth2/idpresponse
```

Save.

---

## 4. Vercel DNS — ACM validation CNAME

Get the validation CNAMEs:

```bash
terraform output acm_validation_cnames
```

You'll see one or more `{ name, value }` entries. In the Vercel dashboard for `davidshubov.com`:

- **Settings → Domains → DNS Records → Add** for each:
  - Type: `CNAME`
  - Name: the `name` field (Vercel will accept either the FQDN or the leaf — paste what `terraform output` printed)
  - Value: the `value` field

Wait ~5–30 minutes. Check status:

```bash
aws acm describe-certificate \
  --region us-east-1 \
  --certificate-arn $(cd infra/aws && terraform output -raw acm_certificate_arn 2>/dev/null) \
  --query 'Certificate.Status'
```

Once it returns `"ISSUED"`, re-run apply so CloudFront picks up the cert:

```bash
cd infra/aws && terraform apply
```

---

## 5. Vercel DNS — CDN CNAME

Now that the CloudFront distribution is deployed:

```bash
cd infra/aws && terraform output -raw cloudfront_distribution_domain
```

In Vercel DNS for `davidshubov.com`, add:

- Type: `CNAME`
- Name: `cdn.photos`
- Value: the `.cloudfront.net` domain from the output

Wait a couple of minutes for propagation. Verify with:

```bash
dig cdn.photos.davidshubov.com CNAME +short
```

You should see the CloudFront domain.

---

## 6. Vercel — link the Next.js project

If the repo isn't already a Vercel project:

- Push the repo to GitHub.
- In Vercel: **Add New → Project → Import** the repo. Framework auto-detects Next.js.

**Settings → Environment Variables.** Copy every value from `scripts/deploy.sh` output. Run it once to print them:

```bash
./scripts/deploy.sh
```

(That script just runs `terraform apply` and then prints the env-var checklist — safe to re-run; if everything is already applied, it'll print "No changes" and the env vars.)

Add each variable to **Production** and **Preview**:

```
COGNITO_DOMAIN
COGNITO_CLIENT_ID
COGNITO_REDIRECT_URI=https://photos.davidshubov.com/auth/callback
COGNITO_LOGOUT_URI=https://photos.davidshubov.com
API_GATEWAY_URL
CLOUDFRONT_URL=https://cdn.photos.davidshubov.com
```

For local dev later, copy `.env.local.example` to `.env.local` and fill the same values with `http://localhost:3000` callbacks.

---

## 7. Vercel — point `photos.davidshubov.com` at the project

- **Settings → Domains → Add** `photos.davidshubov.com`.
- Vercel will detect that you already own `davidshubov.com` and auto-configure the subdomain. No CNAME needed.
- Trigger a deploy (push to `main` or hit "Redeploy").

---

## 8. Smoke test

- Visit `https://photos.davidshubov.com` — expect the empty gallery (`No photographs yet.`).
- Visit `https://photos.davidshubov.com/auth/login` — should redirect through Cognito + Google sign-in and back to `/`.
- After signing in as `david.shubov@gmail.com`, visit `/admin` — should render the upload form (you're seeded as admin in the `photos-users` table).
- Upload a JPEG via `/admin`. Photo should appear within ~60s (resize Lambda runs on S3 trigger).
- Hit the delete button on it. Photo + S3 keys + DDB row all gone.

---

## 9. Things deliberately not built (per the design spec's "Out of scope")

- HEIC ingest (drop / convert on Mac before upload)
- Cursor-based pagination (hard cap of 60 photos)
- Background reconciliation (run `python scripts/reconcile.py` manually if you suspect drift)
- Manual photo ordering / curation
- Image upload progress bars beyond the elapsed-seconds counter
- Multi-region failover

---

## 10. If something breaks

- **`terraform apply` complains about a missing variable.** You forgot `terraform.tfvars`. See step 2.
- **Cognito redirect loops.** Callback URL mismatch — verify `COGNITO_REDIRECT_URI` in Vercel matches exactly what's in `aws_cognito_user_pool_client.web.callback_urls`.
- **`/admin` redirects to `/`.** The role check failed. Verify the `photos-users` DDB table has a row with `email = david.shubov@gmail.com` and `role = admin`. If missing (e.g., you typed a different `admin_email` in tfvars), add it via the AWS Console or re-apply.
- **Upload succeeds but photo never appears.** Check CloudWatch Logs for `/aws/lambda/photos-resize` — Pillow layer ARN is the usual culprit. Update `pillow_layer_arn` in tfvars from the Klayers API.
- **CloudFront returns 403 on every photo.** Bucket policy didn't take effect, or the OAC origin path is wrong. `terraform apply` should be idempotent; re-run.

---

## Reference

- Implementation plan: [`docs/superpowers/plans/2026-06-02-photo-subdomain.md`](../plans/2026-06-02-photo-subdomain.md)
- Design spec: [`docs/superpowers/specs/2026-06-02-photo-subdomain-design.md`](../specs/2026-06-02-photo-subdomain-design.md)
- Original goal: [`GOAL.md`](../../../GOAL.md)
