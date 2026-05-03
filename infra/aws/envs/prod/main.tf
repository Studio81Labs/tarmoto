terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  backend "s3" {
    key            = "envs/prod/terraform.tfstate"
    region         = "eu-central-1"
    encrypt        = true
    dynamodb_table = "tarmoto-tfstate-locks"
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "tarmoto"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "tarmoto"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "api_certificate_arn" {
  type = string
}
variable "cdn_certificate_arn" {
  type = string
}
variable "cdn_aliases" {
  type    = list(string)
  default = []
}

variable "companion_origin" {
  type    = string
  default = "https://tarmoto.app"
}

module "vpc" {
  source             = "../../modules/vpc"
  env                = "prod"
  cidr_block         = "10.20.0.0/16"
  az_count           = 3
  single_nat_gateway = false
}

module "ecr" {
  source = "../../modules/ecr"
  env    = "prod"
}

module "alb" {
  source            = "../../modules/alb"
  env               = "prod"
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = var.api_certificate_arn
}

module "secrets" {
  source = "../../modules/secrets"
  env    = "prod"
}

module "uploads_bucket" {
  source               = "../../modules/s3-bucket"
  env                  = "prod"
  name                 = "uploads"
  versioning_enabled   = true
  cors_allowed_origins = [var.companion_origin]

  # Avatars (`avatars/`) and review photos (`road-review-photos/`) are
  # retained for the lifetime of the user / review — never bulk-expired.
  # The runbook documents that data-export bundles also live in this
  # bucket under `exports/` once that wiring lands; the prefix rule
  # below auto-expires those without affecting retained imagery. The
  # 30-day non-current expiration in the module default cleans up old
  # versions left behind when a user replaces an avatar.
  lifecycle_rules = [
    {
      id              = "expire-exports-prefix"
      prefix          = "exports/"
      expiration_days = 30
    },
  ]
}

module "exports_bucket" {
  source = "../../modules/s3-bucket"
  env    = "prod"
  name   = "exports"

  # Whole-bucket fallback retention for the dedicated exports bucket
  # (kept for parity with staging / future wiring options).
  lifecycle_rules = [
    {
      id              = "expire-all"
      expiration_days = 30
    },
  ]
}

module "tiles_bucket" {
  source = "../../modules/s3-bucket"
  env    = "prod"
  name   = "tiles"
}

module "cdn" {
  source                              = "../../modules/cdn"
  env                                 = "prod"
  tiles_bucket_regional_domain_name   = module.tiles_bucket.regional_domain_name
  tiles_bucket_arn                    = module.tiles_bucket.arn
  uploads_bucket_regional_domain_name = module.uploads_bucket.regional_domain_name
  uploads_bucket_arn                  = module.uploads_bucket.arn
  aliases                             = var.cdn_aliases
  certificate_arn                     = var.cdn_certificate_arn

  providers = {
    aws = aws.us_east_1
  }
}

module "ecs_service" {
  source                = "../../modules/ecs-service"
  env                   = "prod"
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  alb_security_group_id = module.alb.alb_security_group_id
  target_group_arn      = module.alb.target_group_arn

  image         = "public.ecr.aws/docker/library/busybox:stable"
  desired_count = 3
  task_cpu      = 1024
  task_memory   = 2048

  environment = {
    TARMOTO_NODE_ENV         = "production"
    TARMOTO_PORT             = "3000"
    TARMOTO_TRUST_PROXY_HOPS = "1"
    TARMOTO_S3_BUCKET        = module.uploads_bucket.bucket
    TARMOTO_S3_REGION        = var.region
    TARMOTO_STORAGE_DRIVER   = "s3"
    TARMOTO_COMPANION_URL    = var.companion_origin
    TARMOTO_REDIS_HOST       = module.redis.endpoint
    TARMOTO_REDIS_PORT       = tostring(module.redis.port)
    TARMOTO_DATABASE_HOST    = module.rds.endpoint
    TARMOTO_DATABASE_PORT    = tostring(module.rds.port)
    TARMOTO_DATABASE_NAME    = module.rds.db_name
  }

  secret_arns = {
    TARMOTO_DATABASE_PASSWORD       = "${module.rds.secret_arn}:password::"
    TARMOTO_DATABASE_USER           = "${module.rds.secret_arn}:username::"
    TARMOTO_JWT_SECRET              = module.secrets.arns["jwt"]
    TARMOTO_STRIPE_SECRET_KEY       = "${module.secrets.arns["stripe"]}:secret_key::"
    TARMOTO_STRIPE_WEBHOOK_SECRET   = "${module.secrets.arns["stripe"]}:webhook_secret::"
    TARMOTO_STRIPE_PREMIUM_PRICE_ID = "${module.secrets.arns["stripe"]}:premium_price_id::"
    TARMOTO_STRIPE_PRO_PRICE_ID     = "${module.secrets.arns["stripe"]}:pro_price_id::"
    TARMOTO_OWM_API_KEY             = module.secrets.arns["weather"]
  }
}

module "rds" {
  source                     = "../../modules/rds"
  env                        = "prod"
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.private_subnet_ids
  allowed_security_group_ids = [module.ecs_service.service_security_group_id]
  instance_class             = "db.m6g.large"
  multi_az                   = true
  deletion_protection        = true
  backup_retention_days      = 30
  allocated_storage_gb       = 100
  max_allocated_storage_gb   = 500
}

module "redis" {
  source                     = "../../modules/redis"
  env                        = "prod"
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.private_subnet_ids
  allowed_security_group_ids = [module.ecs_service.service_security_group_id]
  node_type                  = "cache.m6g.large"
  replicas_per_node_group    = 1
  automatic_failover_enabled = true
}

output "alb_dns_name" { value = module.alb.alb_dns_name }
output "ecr_repository_url" { value = module.ecr.repository_url }
output "ecs_cluster_name" { value = module.ecs_service.cluster_name }
output "ecs_service_name" { value = module.ecs_service.service_name }
output "rds_endpoint" {
  value     = module.rds.endpoint
  sensitive = true
}
output "redis_endpoint" {
  value     = module.redis.endpoint
  sensitive = true
}
output "cdn_domain_name" { value = module.cdn.domain_name }
