resource "aws_acm_certificate" "cdn" {
  domain_name       = var.cdn_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records are added MANUALLY in Vercel DNS (Vercel manages the root zone).
# See outputs.tf for the CNAME values to copy.
