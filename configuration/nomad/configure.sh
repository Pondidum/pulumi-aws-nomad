#!/bin/bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_NAME="$(basename "$0")"

log() {
  local -r level="$1"
  local -r message="$2"
  local -r timestamp=$(date +"%Y-%m-%d %H:%M:%S")
  >&2 echo -e "${timestamp} [${level}] [$SCRIPT_NAME] ${message}"
}

assert_not_empty() {
  local -r arg_name="$1"
  local -r arg_value="$2"

  if [[ -z "$arg_value" ]]; then
    log "ERROR" "The value for '$arg_name' cannot be empty"
    exit 1
  fi
}

assert_exists() {
  local -r path="$1"

  if ! [[ -e "$path" ]]; then
    log "ERROR" "The file '$path' does not exist"
    exit 1
  fi
}

bootstrap_acl() {
  log "INFO" "Bootstrapping Nomad ACL"

  local -r secret_id=$(nomad acl bootstrap | sed -n 's/Secret ID.*= \(.*\)/\1/p')

  export NOMAD_TOKEN="$secret_id"

}

write_policies() {
  log "INFO" "Writing Nomad ACL Policies"

  local policy_path
  for policy_path in "$SCRIPT_DIR"/policy/*.hcl; do

    local policy_name=$(basename "$policy_path" .hcl)

    nomad acl policy apply "$policy_name" "$policy_path"
  done

}

configure_vault() {

  local -r vault_token=$(nomad acl token create -name vault -type management | sed -n 's/Secret ID.*= \(.*\)/\1/p')

  vault write nomad/config/access \
    address=https://nomad.service.consul:4646 \
    token="$vault_token"

  vault write nomad/config/lease \
    ttl=3600 \
    max_ttl=86400

  local policy_path
  for policy_path in "$SCRIPT_DIR"/policy/*.hcl; do

    local policy_name=$(basename "$policy_path" .hcl)

    vault write "nomad/role/$policy_name" \
      policies="$policy_name"

  done

  vault write "nomad/role/cluster-admin" \
    type="management"
}

run() {

  bootstrap_acl
  write_policies

  configure_vault
}

run "$@"