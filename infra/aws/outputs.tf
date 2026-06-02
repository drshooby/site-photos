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
  description = "Add a CNAME for cdn_domain pointing to this value in Vercel DNS."
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

output "api_gateway_url" {
  value = "${aws_api_gateway_stage.prod.invoke_url}"
}
