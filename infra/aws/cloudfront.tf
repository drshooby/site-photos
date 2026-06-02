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
