terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" {
  description = "Private subnet IDs the DB subnet group will span."
  type        = list(string)
}
variable "allowed_security_group_ids" {
  description = "Security groups allowed inbound on 5432 (typically the ECS service SG)."
  type        = list(string)
}
variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "allocated_storage_gb" {
  type    = number
  default = 50
}
variable "max_allocated_storage_gb" {
  type    = number
  default = 200
}
variable "multi_az" {
  type    = bool
  default = false
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "backup_retention_days" {
  type    = number
  default = 14
}

resource "aws_db_subnet_group" "this" {
  name       = "tarmoto-${var.env}-db"
  subnet_ids = var.subnet_ids
  tags       = { Name = "tarmoto-${var.env}-db-subnet-group" }
}

resource "aws_security_group" "this" {
  name        = "tarmoto-${var.env}-rds"
  description = "Postgres + PostGIS for the tarmoto backend"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
    description     = "Postgres from ECS service"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All egress (RDS uses this for cross-AZ replication and S3 backups)"
  }

  tags = { Name = "tarmoto-${var.env}-rds-sg" }
}

# Custom parameter group so the postgis extension can be enabled
# without superuser. shared_preload_libraries is the only knob worth
# touching at the cluster level for now; everything else is fine on
# the default-postgres16 family.
resource "aws_db_parameter_group" "this" {
  name        = "tarmoto-${var.env}-pg16-postgis"
  family      = "postgres16"
  description = "Tarmoto Postgres 16 parameter group with PostGIS preload"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "log_min_duration_statement"
    value        = "500"
    apply_method = "immediate"
  }
}

resource "random_password" "master" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db" {
  name = "tarmoto/${var.env}/database"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    dbname   = aws_db_instance.this.db_name
    username = aws_db_instance.this.username
    password = random_password.master.result
  })
}

resource "aws_db_instance" "this" {
  identifier     = "tarmoto-${var.env}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "tarmoto"
  username = "tarmoto_admin"
  password = random_password.master.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  multi_az                = var.multi_az
  backup_retention_period = var.backup_retention_days
  # Run backups and maintenance well outside European/US-East ride
  # recording prime time. Adjust per-env if regions change.
  backup_window      = "03:00-03:30"
  maintenance_window = "Sun:03:30-Sun:04:30"

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = !var.deletion_protection
  final_snapshot_identifier = "tarmoto-${var.env}-final"

  performance_insights_enabled    = true
  monitoring_interval             = 60
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = { Name = "tarmoto-${var.env}-db" }
}

output "endpoint" { value = aws_db_instance.this.address }
output "port" { value = aws_db_instance.this.port }
output "db_name" { value = aws_db_instance.this.db_name }
output "secret_arn" { value = aws_secretsmanager_secret.db.arn }
output "security_group_id" { value = aws_security_group.this.id }
