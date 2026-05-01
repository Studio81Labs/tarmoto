terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "allowed_security_group_ids" { type = list(string) }
variable "node_type" {
  type    = string
  default = "cache.t4g.small"
}
variable "replicas_per_node_group" {
  description = "0 in staging (single node), 1+ in prod for failover."
  type        = number
  default     = 0
}
variable "automatic_failover_enabled" {
  type    = bool
  default = false
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "tarmoto-${var.env}-redis"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "this" {
  name        = "tarmoto-${var.env}-redis"
  description = "Redis for tarmoto pub/sub + BullMQ"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
    description     = "Redis from ECS service"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "tarmoto-${var.env}-redis-sg" }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "tarmoto-${var.env}-redis"
  description          = "Tarmoto pub/sub + BullMQ"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.node_type
  port                 = 6379

  num_node_groups            = 1
  replicas_per_node_group    = var.replicas_per_node_group
  automatic_failover_enabled = var.automatic_failover_enabled
  multi_az_enabled           = var.automatic_failover_enabled

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = false

  # The backend can replay queue state from Postgres for the workers
  # we care about (account-deletion, data-export, fun-zone). Daily
  # snapshot is enough — if Redis dies, BullMQ jobs in flight retry
  # idempotently on next enqueue.
  snapshot_retention_limit = 1
  snapshot_window          = "03:00-04:00"
  maintenance_window       = "sun:04:00-sun:05:00"

  apply_immediately = true

  tags = { Name = "tarmoto-${var.env}-redis" }
}

output "endpoint" {
  description = "Primary endpoint host for the replication group."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" { value = 6379 }
output "security_group_id" { value = aws_security_group.this.id }
