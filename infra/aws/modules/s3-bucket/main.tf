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
variable "multipart_abort_days" {
  description = "Days after which incomplete multipart uploads are aborted. Set 0 to disable; default 7 keeps abandoned uploads from accumulating storage cost."
  type        = number
  default     = 7
}
variable "noncurrent_version_expiration_days" {
  description = "Days after which non-current object versions are expired. Has no effect unless versioning_enabled = true. Set 0 to disable."
  type        = number
  default     = 30
}
variable "lifecycle_rules" {
  description = "Per-prefix expiration rules. Each entry expires the current version of objects under prefix after expiration_days. Use this for buckets where part of the contents (e.g. exports/) should auto-expire while the rest is retained."
  type = list(object({
    id              = string
    prefix          = optional(string, "")
    expiration_days = number
  }))
  default = []
}
variable "cors_allowed_origins" {
  description = "Origins permitted for browser CORS. Empty disables CORS entirely."
  type        = list(string)
  default     = []
}

locals {
  has_multipart_rule        = var.multipart_abort_days > 0
  has_noncurrent_rule       = var.versioning_enabled && var.noncurrent_version_expiration_days > 0
  has_any_lifecycle_content = local.has_multipart_rule || local.has_noncurrent_rule || length(var.lifecycle_rules) > 0
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
  count  = local.has_any_lifecycle_content ? 1 : 0
  bucket = aws_s3_bucket.this.id

  dynamic "rule" {
    for_each = local.has_multipart_rule ? [1] : []
    content {
      id     = "abort-incomplete-multipart"
      status = "Enabled"

      filter {}

      abort_incomplete_multipart_upload {
        days_after_initiation = var.multipart_abort_days
      }
    }
  }

  dynamic "rule" {
    for_each = local.has_noncurrent_rule ? [1] : []
    content {
      id     = "expire-noncurrent-versions"
      status = "Enabled"

      filter {}

      noncurrent_version_expiration {
        noncurrent_days = var.noncurrent_version_expiration_days
      }
    }
  }

  dynamic "rule" {
    for_each = { for r in var.lifecycle_rules : r.id => r }
    content {
      id     = rule.value.id
      status = "Enabled"

      filter {
        prefix = rule.value.prefix
      }

      expiration {
        days = rule.value.expiration_days
      }
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
