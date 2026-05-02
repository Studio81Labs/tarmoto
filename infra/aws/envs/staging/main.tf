terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # The bucket / dynamodb table values come from backend.hcl,
  # populated after running infra/aws/bootstrap once.
  backend "s3" {
    key            = "envs/staging/terraform.tfstate"
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
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

# CloudFront certificates must live in us-east-1 regardless of the
# rest of the stack's region. We expect the cert to be created by an
# operator (it requires DNS validation) and its ARN passed in.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "tarmoto"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "api_certificate_arn" {
  description = "ACM cert ARN in var.region for the API hostname (e.g. api.staging.tarmoto.app)."
  type        = string
}

variable "cdn_certificate_arn" {
  description = "ACM cert ARN in us-east-1 for the CloudFront aliases."
  type        = string
}

variable "cdn_aliases" {
  description = "Custom domains served by CloudFront."
  type        = list(string)
  default     = []
}

variable "companion_origin" {
  description = "Companion URL — used by the backend to build OAuth/Stripe redirect URLs."
  type        = string
  default     = "https://staging.tarmoto.app"
}

# Push provider activation gates. ECS rejects a task whose `secrets`
# reference a JSON key that doesn't exist in the underlying secret,
# so we only wire the FCM/APN env vars into the task definition once
# the operator has populated `tarmoto/staging/{fcm,apn}` in Secrets
# Manager. Flip these in `terraform.tfvars` after running the
# `aws secretsmanager put-secret-value` calls documented in
# `docs/process/runbook.md` § "Push notifications (FCM + APN)".
variable "fcm_secret_enabled" {
  description = "Wire TARMOTO_FCM_* into the backend task. Set to true only after populating tarmoto/staging/fcm with project_id / client_email / private_key keys."
  type        = bool
  default     = false
}

variable "apn_secret_enabled" {
  description = "Wire TARMOTO_APN_* into the backend task. Set to true only after populating tarmoto/staging/apn with key / key_id / team_id / topic / production keys."
  type        = bool
  default     = false
}

module "vpc" {
  source             = "../../modules/vpc"
  env                = "staging"
  cidr_block         = "10.40.0.0/16"
  az_count           = 2
  single_nat_gateway = true
}

module "ecr" {
  source = "../../modules/ecr"
  env    = "staging"
}

module "alb" {
  source            = "../../modules/alb"
  env               = "staging"
  vpc_id            = module.vpc.vpc_id
  public_subnet_ids = module.vpc.public_subnet_ids
  certificate_arn   = var.api_certificate_arn
}

module "secrets" {
  source = "../../modules/secrets"
  env    = "staging"
  # `fcm` / `apn` are created empty here so ops can populate them via
  # `aws secretsmanager put-secret-value` ahead of flipping the
  # `*_secret_enabled` gates above. See runbook § "Push notifications
  # (FCM + APN)".
  secret_names = ["jwt", "stripe", "weather", "fcm", "apn"]
}

module "uploads_bucket" {
  source                    = "../../modules/s3-bucket"
  env                       = "staging"
  name                      = "uploads"
  cors_allowed_origins      = [var.companion_origin]
  lifecycle_expiration_days = 0
}

module "exports_bucket" {
  source                    = "../../modules/s3-bucket"
  env                       = "staging"
  name                      = "exports"
  lifecycle_expiration_days = 30
}

module "tiles_bucket" {
  source = "../../modules/s3-bucket"
  env    = "staging"
  name   = "tiles"
}

module "cdn" {
  source                              = "../../modules/cdn"
  env                                 = "staging"
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
  env                   = "staging"
  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  alb_security_group_id = module.alb.alb_security_group_id
  target_group_arn      = module.alb.target_group_arn

  # First apply uses a placeholder image. CI takes over from there;
  # `lifecycle.ignore_changes = [task_definition]` in the module
  # keeps Terraform from fighting the deploy workflow.
  image         = "public.ecr.aws/docker/library/busybox:stable"
  desired_count = 1
  task_cpu      = 512
  task_memory   = 1024

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

  secret_arns = merge(
    {
      TARMOTO_DATABASE_PASSWORD       = "${module.rds.secret_arn}:password::"
      TARMOTO_DATABASE_USER           = "${module.rds.secret_arn}:username::"
      TARMOTO_JWT_SECRET              = module.secrets.arns["jwt"]
      TARMOTO_STRIPE_SECRET_KEY       = "${module.secrets.arns["stripe"]}:secret_key::"
      TARMOTO_STRIPE_WEBHOOK_SECRET   = "${module.secrets.arns["stripe"]}:webhook_secret::"
      TARMOTO_STRIPE_PREMIUM_PRICE_ID = "${module.secrets.arns["stripe"]}:premium_price_id::"
      TARMOTO_STRIPE_PRO_PRICE_ID     = "${module.secrets.arns["stripe"]}:pro_price_id::"
      TARMOTO_OWM_API_KEY             = module.secrets.arns["weather"]
    },
    var.fcm_secret_enabled ? {
      TARMOTO_FCM_PROJECT_ID   = "${module.secrets.arns["fcm"]}:project_id::"
      TARMOTO_FCM_CLIENT_EMAIL = "${module.secrets.arns["fcm"]}:client_email::"
      TARMOTO_FCM_PRIVATE_KEY  = "${module.secrets.arns["fcm"]}:private_key::"
    } : {},
    var.apn_secret_enabled ? {
      TARMOTO_APN_KEY        = "${module.secrets.arns["apn"]}:key::"
      TARMOTO_APN_KEY_ID     = "${module.secrets.arns["apn"]}:key_id::"
      TARMOTO_APN_TEAM_ID    = "${module.secrets.arns["apn"]}:team_id::"
      TARMOTO_APN_TOPIC      = "${module.secrets.arns["apn"]}:topic::"
      TARMOTO_APN_PRODUCTION = "${module.secrets.arns["apn"]}:production::"
    } : {},
  )
}

module "rds" {
  source                     = "../../modules/rds"
  env                        = "staging"
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.private_subnet_ids
  allowed_security_group_ids = [module.ecs_service.service_security_group_id]
  instance_class             = "db.t4g.medium"
  multi_az                   = false
  deletion_protection        = false
  backup_retention_days      = 7
}

module "redis" {
  source                     = "../../modules/redis"
  env                        = "staging"
  vpc_id                     = module.vpc.vpc_id
  subnet_ids                 = module.vpc.private_subnet_ids
  allowed_security_group_ids = [module.ecs_service.service_security_group_id]
  node_type                  = "cache.t4g.small"
  replicas_per_node_group    = 0
  automatic_failover_enabled = false
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
