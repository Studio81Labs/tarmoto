terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

variable "env" { type = string }
variable "tiles_bucket_regional_domain_name" { type = string }
variable "tiles_bucket_arn" { type = string }
variable "uploads_bucket_regional_domain_name" { type = string }
variable "uploads_bucket_arn" { type = string }
variable "aliases" {
  description = "Custom domains for the CDN (e.g. tiles.tarmoto.app)."
  type        = list(string)
  default     = []
}
variable "certificate_arn" {
  description = "ACM cert ARN — must be in us-east-1 for CloudFront."
  type        = string
}

resource "aws_cloudfront_origin_access_control" "tiles" {
  name                              = "tarmoto-${var.env}-tiles-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "uploads" {
  name                              = "tarmoto-${var.env}-uploads-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "tarmoto ${var.env} static + tiles"
  price_class     = "PriceClass_100"
  aliases         = var.aliases

  origin {
    origin_id                = "tiles"
    domain_name              = var.tiles_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.tiles.id
  }

  origin {
    origin_id                = "uploads"
    domain_name              = var.uploads_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.uploads.id
  }

  # Default behavior serves vector tiles. Tiles are content-addressed
  # by zoom/x/y so they're effectively immutable.
  default_cache_behavior {
    target_origin_id       = "tiles"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    min_ttl                = 0
    default_ttl            = 86400    # 1 day
    max_ttl                = 31536000 # 1 year

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  # /uploads/* routes to the uploads bucket. Avatar URLs are also
  # effectively immutable (we name files by content hash on rotation).
  ordered_cache_behavior {
    path_pattern           = "/uploads/*"
    target_origin_id       = "uploads"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    min_ttl                = 0
    default_ttl            = 3600
    max_ttl                = 86400

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# Bucket policies: only the CloudFront distribution can read the
# objects. The ECS task writes via SigV4 against the regional
# endpoint and uses CloudFront only as a read-through cache.
data "aws_iam_policy_document" "tiles_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.tiles_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

data "aws_iam_policy_document" "uploads_policy" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${var.uploads_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "tiles" {
  bucket = element(split(":", var.tiles_bucket_arn), 5)
  policy = data.aws_iam_policy_document.tiles_policy.json
}

resource "aws_s3_bucket_policy" "uploads" {
  bucket = element(split(":", var.uploads_bucket_arn), 5)
  policy = data.aws_iam_policy_document.uploads_policy.json
}

output "domain_name" { value = aws_cloudfront_distribution.this.domain_name }
output "distribution_id" { value = aws_cloudfront_distribution.this.id }
output "hosted_zone_id" { value = aws_cloudfront_distribution.this.hosted_zone_id }
