terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

variable "env" { type = string }
variable "name" {
  description = "Logical name suffix (e.g. uploads, exports, tiles). Final bucket = tarmoto-<env>-<name>."
  type        = string
}
variable "versioning_enabled" {
  type    = bool
  default = false
}
variable "lifecycle_expiration_days" {
  description = "Days after which non-current and incomplete objects are expired. 0 disables."
  type        = number
  default     = 0
}
variable "cors_allowed_origins" {
  description = "Origins permitted for browser CORS. Empty disables CORS entirely."
  type        = list(string)
  default     = []
}

resource "aws_s3_bucket" "this" {
  bucket = "tarmoto-${var.env}-${var.name}"
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = var.versioning_enabled ? "Enabled" : "Disabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  count  = var.lifecycle_expiration_days > 0 ? 1 : 0
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-noncurrent"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = var.lifecycle_expiration_days
    }

    expiration {
      days = var.lifecycle_expiration_days
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "this" {
  count  = length(var.cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

output "bucket" { value = aws_s3_bucket.this.id }
output "arn" { value = aws_s3_bucket.this.arn }
output "regional_domain_name" { value = aws_s3_bucket.this.bucket_regional_domain_name }
