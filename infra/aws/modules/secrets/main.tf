terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.70" }
  }
}

variable "env" { type = string }

variable "secret_names" {
  description = "Logical secret names — final id is tarmoto/<env>/<name>. The values are populated out-of-band (CI / ops) and the deploy workflow will fail loudly if any are missing."
  type        = list(string)
  default = [
    "jwt",
    "stripe",
    "weather",
  ]
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.secret_names)
  name     = "tarmoto/${var.env}/${each.value}"
}

# A guard placeholder so the secret has a JSON document on first plan.
# Real values are written by ops via:
#   aws secretsmanager put-secret-value --secret-id tarmoto/<env>/<name> ...
# The placeholder is preserved across applies because we don't write
# any secret_version resource here — nothing to drift against.

output "arns" {
  value = { for k, v in aws_secretsmanager_secret.this : k => v.arn }
}
