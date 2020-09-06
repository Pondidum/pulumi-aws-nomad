vault {
  enabled = true
  address = "https://vault.service.consul:8200"
  task_token_ttl = "1h"
  create_from_role = "nomad-cluster"
}
