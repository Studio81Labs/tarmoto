# Tarmoto AWS infrastructure (Terraform)

This is the Terraform footprint for Tarmoto's backend stack on AWS.
Choice rationale lives in [ADR 0004](../../docs/decisions/0004-deployment-stack.md).
For day-2 operations (deploy, rollback, on-call) see
[../../docs/process/runbook.md](../../docs/process/runbook.md).

```
infra/aws/
  bootstrap/        Run ONCE per AWS account to create the Terraform
                    state bucket, the DynamoDB lock table, and the
                    GitHub Actions OIDC role. Bootstrap state is local
                    on purpose — chicken/egg.
  modules/          Reusable building blocks (vpc, rds, redis, ...).
                    Modules are dumb: they expose inputs/outputs only,
                    no policy lives at the module layer.
  envs/
    staging/        Per-environment root module. State backend is the
    prod/           bucket created by bootstrap; each env has its own
                    state key so you cannot accidentally apply prod
                    while standing in staging.
```

## Prerequisites

- An AWS account per environment (or one account with strict IAM separation; we recommend separate accounts).
- A registered domain in Route 53 you control. The deploy expects a hosted zone for `tarmoto.app` (prod) and `staging.tarmoto.app` (staging) — adjust per `envs/<name>/terraform.tfvars`.
- Terraform `>= 1.9.0` and the AWS CLI configured with credentials for the target account when running locally. CI uses an OIDC-assumed role.

## One-time bootstrap (per account)

```bash
cd infra/aws/bootstrap
terraform init
terraform apply -var "env=staging"   # or prod
```

Bootstrap creates:

- `tarmoto-tfstate-<env>-<account-id>` S3 bucket (versioned, encrypted, public access blocked).
- `tarmoto-tfstate-locks` DynamoDB table for state locking.
- `tarmoto-github-actions-<env>` IAM role assumable by GitHub Actions via OIDC, scoped to this repo.
- The OIDC provider for `token.actions.githubusercontent.com`.

Outputs include the role ARN to put in repo secrets as `AWS_DEPLOY_ROLE_ARN_STAGING` / `AWS_DEPLOY_ROLE_ARN_PROD`, and the state bucket name to put in `envs/<env>/backend.hcl`.

## Per-environment apply

```bash
cd infra/aws/envs/staging
terraform init -backend-config=backend.hcl
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

The first apply is intentionally manual. CI applies plans against PRs (read-only `terraform plan`) and applies to the live environment only on merge to `main` for staging; prod applies are gated behind a manual approval in the GitHub `production` environment.

## What gets created

Per environment:

- A 3-AZ VPC with public + private subnets (NAT gateway in each AZ for prod, single NAT in staging).
- RDS Postgres 16 with PostGIS 3.4 in the private subnets, with automated backups and a scheduled maintenance window outside ride-recording prime time.
- ElastiCache Redis 8 (single node in staging, replication group in prod).
- An ECR repository for the `tarmoto-backend` image.
- An ECS Fargate cluster + service running the backend behind an Application Load Balancer with HTTPS termination via ACM.
- S3 buckets for `uploads`, `exports`, and `tiles`, each with object lifecycle policies.
- CloudFront distribution in front of the `tiles` and static-asset buckets, plus a separate distribution for the API hostname (origin = ALB).
- AWS Secrets Manager entries for `database`, `redis`, `jwt`, `stripe`, `weather`, and a per-env namespace under SSM Parameter Store for non-secret config.
- CloudWatch log groups + Container Insights enabled on the cluster.

Outputs include the ALB DNS, ECR repository URL, RDS endpoint, and the names of the secrets the deploy workflow will reference.

## Conventions

- All resources are tagged with `Project = tarmoto`, `Environment = <env>`, `ManagedBy = terraform`.
- Naming is `tarmoto-<env>-<resource>`; this avoids collisions when staging and prod share an account.
- We use `var.env` not `terraform.workspace` — workspaces hide environment from state inspection and we want it explicit.
- No module is invoked twice in one root for "logical" reasons (e.g. there is one ECS service module call, not "api" + "worker" — the worker toggle is per-replica via env).
