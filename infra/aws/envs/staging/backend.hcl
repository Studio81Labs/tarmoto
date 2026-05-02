# Populated after `cd infra/aws/bootstrap && terraform apply -var env=staging`.
# The output `state_bucket` goes here. Commit this file with the real
# bucket name once the bootstrap has run — it's not sensitive (the
# bucket is private and the bucket name has no auth value on its own).
bucket = "REPLACE-ME-tarmoto-tfstate-staging-<account-id>"
