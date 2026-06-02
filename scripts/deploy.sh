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
