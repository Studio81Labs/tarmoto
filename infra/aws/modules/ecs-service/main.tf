terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

variable "env" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "target_group_arn" { type = string }

variable "image" {
  description = "Initial container image. CI overrides this on every deploy via aws-actions/amazon-ecs-deploy-task-definition."
  type        = string
}

variable "container_port" {
  type    = number
  default = 3000
}
variable "task_cpu" {
  type    = number
  default = 1024
}
variable "task_memory" {
  type    = number
  default = 2048
}
variable "desired_count" {
  type    = number
  default = 2
}

variable "environment" {
  description = "Plain (non-secret) env vars baked into the task definition."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Map of env var name -> Secrets Manager / SSM ARN. Injected at runtime."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  type    = number
  default = 30
}

locals {
  cluster_name = "tarmoto-${var.env}"
  service_name = "tarmoto-${var.env}-backend"
  family_name  = "tarmoto-${var.env}-backend"
}

resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/tarmoto/${var.env}/backend"
  retention_in_days = var.log_retention_days
}

resource "aws_security_group" "service" {
  name        = "tarmoto-${var.env}-backend-svc"
  description = "Tarmoto backend Fargate task SG"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [var.alb_security_group_id]
    description     = "HTTP from ALB"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All egress (RDS, Redis, S3, third-party APIs)"
  }

  tags = { Name = "tarmoto-${var.env}-backend-sg" }
}

# Execution role: pulls image from ECR, writes logs, reads secrets.
data "aws_iam_policy_document" "task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "tarmoto-${var.env}-backend-exec"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "tarmoto-${var.env}-backend-exec-secrets"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "kms:Decrypt",
        ]
        Resource = "*"
      },
    ]
  })
}

# Task role: what the running container is allowed to do at runtime.
# Scoped to S3 (uploads, exports, tiles) and SES if/when wired.
resource "aws_iam_role" "task" {
  name               = "tarmoto-${var.env}-backend-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy" "task_s3" {
  name = "tarmoto-${var.env}-backend-task-s3"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetObjectAcl",
          "s3:PutObjectAcl",
        ]
        Resource = [
          "arn:aws:s3:::tarmoto-${var.env}-uploads",
          "arn:aws:s3:::tarmoto-${var.env}-uploads/*",
          "arn:aws:s3:::tarmoto-${var.env}-exports",
          "arn:aws:s3:::tarmoto-${var.env}-exports/*",
          "arn:aws:s3:::tarmoto-${var.env}-tiles",
          "arn:aws:s3:::tarmoto-${var.env}-tiles/*",
        ]
      },
    ]
  })
}

locals {
  env_vars = [
    for k, v in var.environment : { name = k, value = v }
  ]
  secret_vars = [
    for k, v in var.secret_arns : { name = k, valueFrom = v }
  ]
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.family_name
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = var.image
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = local.env_vars
      secrets     = local.secret_vars
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "backend"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${var.container_port}/api/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 15
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    }
  ])
}

data "aws_region" "current" {}

resource "aws_ecs_service" "this" {
  name            = local.service_name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "backend"
    container_port   = var.container_port
  }

  # The task definition is updated out-of-band by the deploy workflow.
  # Without ignore_changes, every plan would want to roll back to the
  # last Terraform-managed image tag.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  # Ordering against the ALB listener is not declared here: the
  # implicit edge through `target_group_arn` already gates the
  # service on the TG, and the listener (created in the alb module)
  # also depends on the same TG. So by the time the service
  # registers, the listener is up — without needing a meaningless
  # `depends_on` on a variable, which Terraform silently ignores.
}

output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.this.name }
output "task_family" { value = aws_ecs_task_definition.this.family }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "service_security_group_id" { value = aws_security_group.service.id }
output "log_group_name" { value = aws_cloudwatch_log_group.this.name }
