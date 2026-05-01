terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "tarmoto"
      Environment = var.env
      ManagedBy   = "terraform"
      Component   = "bootstrap"
    }
  }
}

variable "env" {
  description = "Environment name (staging or prod). Bootstrap is idempotent per env."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be staging or prod."
  }
}

variable "region" {
  description = "AWS region. Stays the same across environments unless the env is intentionally region-pinned."
  type        = string
  default     = "eu-central-1"
}

variable "github_org" {
  description = "GitHub organisation that owns the tarmoto repo. The OIDC trust policy is scoped to this org."
  type        = string
  default     = "Studio81Labs"
}

variable "github_repo" {
  description = "Repository name under github_org. The OIDC role only trusts this repo."
  type        = string
  default     = "tarmoto"
}

data "aws_caller_identity" "current" {}

locals {
  state_bucket_name = "tarmoto-tfstate-${var.env}-${data.aws_caller_identity.current.account_id}"
  oidc_role_name    = "tarmoto-github-actions-${var.env}"
}

resource "aws_s3_bucket" "tfstate" {
  bucket = local.state_bucket_name
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# A single shared lock table across envs is fine — DynamoDB locks are
# keyed on the state path, so staging and prod cannot collide.
resource "aws_dynamodb_table" "tfstate_lock" {
  name         = "tarmoto-tfstate-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# GitHub Actions OIDC provider. Idempotent: if it already exists in the
# account (e.g. the other env's bootstrap created it first), import it
# rather than recreating.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Scope to this repo's main branch and any tag — PRs from forks
    # cannot assume the role, even if a maintainer is asleep at the wheel.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_org}/${var.github_repo}:ref:refs/tags/*",
        "repo:${var.github_org}/${var.github_repo}:environment:${var.env}",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = local.oidc_role_name
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

# Permissions are intentionally broad here so the deploy workflow can
# update ECS services, push to ECR, read SSM params, and read Secrets
# Manager values. Tighten with a per-resource policy once the resource
# names stabilise after the first prod apply.
resource "aws_iam_role_policy_attachment" "github_actions_ecs" {
  role       = aws_iam_role.github_actions.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonECS_FullAccess"
}

resource "aws_iam_role_policy_attachment" "github_actions_ecr" {
  role       = aws_iam_role.github_actions.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser"
}

resource "aws_iam_role_policy" "github_actions_inline" {
  name = "tarmoto-github-actions-inline-${var.env}"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Allow the workflow to read non-secret config from SSM and
        # secret references from Secrets Manager (for verifying that a
        # secret rotation succeeded), but never write to either.
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "secretsmanager:DescribeSecret",
          "secretsmanager:ListSecrets",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["sts:GetCallerIdentity", "iam:PassRole"]
        Resource = "*"
      },
    ]
  })
}

output "state_bucket" {
  description = "Name of the S3 bucket created for Terraform state. Put this in envs/<env>/backend.hcl."
  value       = aws_s3_bucket.tfstate.id
}

output "lock_table" {
  description = "DynamoDB table name used for state locking."
  value       = aws_dynamodb_table.tfstate_lock.id
}

output "github_actions_role_arn" {
  description = "Role ARN to put in the repo secret (AWS_DEPLOY_ROLE_ARN_<ENV>)."
  value       = aws_iam_role.github_actions.arn
}
