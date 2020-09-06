#!/bin/bash

set -e

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


configure_iam_auth() {

  log "INFO" "Configuring IAM Auth..."
  vault auth enable aws

  vault policy write auth-renew "$SCRIPT_DIR/auth-renew.hcl"
}

# --------------------------------------------------------------------------- #

configure_pki() {

  local ca_cert_file="$1"
  local ca_key_file="$2"
  local domains="$3"

  log "INFO" "Configuring PKI..."

  pem=$(cat "$ca_cert_file" "$ca_key_file")

  vault secrets enable pki
  vault secrets tune -max-lease-ttl=72h pki
  vault write pki/config/ca pem_bundle="$pem"

  vault write pki/roles/cert \
    allowed_domains="$domains" \
    allow_subdomains=true \
    max_ttl=43800h

  vault policy write create-certificate "$SCRIPT_DIR/create-certificate.hcl"

  log "INFO" "Done."
}

configure_kv() {
  vault secrets enable -version=2 kv
}

# --------------------------------------------------------------------------- #

configure_vault_access() {

  local vault_role_arn="$1"

  log "INFO" "Configuring Vault Cluster access"

  vault write \
    auth/aws/role/vault-server \
    auth_type=iam \
    policies=create-certificate,auth-renew,consul-client \
    max_ttl=500h \
    bound_iam_principal_arn="$vault_role_arn"

}

configure_consul_access() {
  local consul_role_arn="$1"

  log "INFO" "Configuring Consul Server access"

  vault policy write consul-server "$SCRIPT_DIR/consul-server.hcl"
  vault policy write consul-client "$SCRIPT_DIR/consul-client.hcl"

  vault write \
    auth/aws/role/consul-server \
    auth_type=iam \
    policies=create-certificate,auth-renew,consul-server \
    max_ttl=500h \
    bound_iam_principal_arn="$consul_role_arn"

  vault kv put kv/consul gossip-key="$(consul keygen)"
}

configure_nomad_access() {
  local nomad_role_arn="$1"

  log "INFO" "Configuring Nomad Server access"

  vault policy write nomad-server "$SCRIPT_DIR/nomad-server.hcl"
  vault policy write nomad-client "$SCRIPT_DIR/nomad-client.hcl"

  vault write /auth/token/roles/nomad-cluster @"$SCRIPT_DIR/nomad-cluster-role.json"

  vault write \
    auth/aws/role/nomad-server \
    auth_type=iam \
    policies=create-certificate,auth-renew,consul-client,nomad-server \
    max_ttl=500h \
    bound_iam_principal_arn="$nomad_role_arn"

  vault kv put kv/nomad gossip-key="$(consul keygen)"
}


run() {
  local domains="localhost"
  local vault_role_arn=""
  local consul_role_arn=""
  local nomad_role_arn=""

  while [[ $# -gt 0 ]]; do
    local key="$1"

    case "$key" in
      --domains)
        domains="$2"
        shift
        ;;
      --vault-role-arn)
        vault_role_arn="$2"
        shift
        ;;
      --consul-role-arn)
        consul_role_arn="$2"
        shift
        ;;
      --nomad-role-arn)
        nomad_role_arn="$2"
        shift
        ;;
      *)
        log "ERROR" "Unrecognized argument: $key"
        exit 1
        ;;
    esac

    shift
  done

  log "INFO" "Running in $SCRIPT_DIR"

  local ca_cert_file="$SCRIPT_DIR/tls/int.crt"
  local ca_key_file="$SCRIPT_DIR/tls/int.key"

  assert_exists "$ca_cert_file"
  assert_exists "$ca_key_file"

  assert_not_empty "--vault-role-arn" "$vault_role_arn"
  assert_not_empty "--consul-role-arn" "$consul_role_arn"
  assert_not_empty "--nomad-role-arn" "$nomad_role_arn"
  assert_not_empty "--domains" "$domains"

  configure_iam_auth

  configure_pki "$ca_cert_file" "$ca_key_file" "$domains"
  configure_kv

  configure_vault_access  "$vault_role_arn"
  configure_consul_access "$consul_role_arn"
  configure_nomad_access "$nomad_role_arn"

}

run "$@"