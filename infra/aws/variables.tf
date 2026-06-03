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
  default     = "arn:aws:lambda:us-east-1:770693421928:layer:Klayers-p312-Pillow:11"
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
