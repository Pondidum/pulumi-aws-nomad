#!/bin/bash

set -e

readonly TOKEN_FILE=".root_token"
readonly SCRIPT_NAME="$(basename "$0")"

export AWS_PROFILE="personal"

log() {

  local readonly level="$1"
  local readonly message="$2"
  local readonly timestamp=$(date +"%Y-%m-%d %H:%M:%S")

  local green='\033[1;32m'
  local normal='\033[0m'

  >&2 echo -e "${green}${timestamp} [${level}] [$SCRIPT_NAME] ${message}${normal}"
}

readonly BASTION_IP=$(./scripts/find-bastion)
readonly VIA_BASTION="ProxyCommand ssh ubuntu@$BASTION_IP -W %h:%p"


lookup_private_ips() {
  local -r cluster_tag_value="$1"
  local -r cluster_tag="Name"
  local -r region="eu-west-1"

  local -r ips=$(aws ec2 describe-instances \
    --region "$region" \
    --filter "Name=tag:$cluster_tag,Values=$cluster_tag_value" "Name=instance-state-name,Values=running" \
    | jq -r '.Reservations[].Instances[].PrivateIpAddress')

  echo "$ips"
}

initialise_vault() {
  local -r vault_ip="$1"

  init_response=$(ssh -o "StrictHostKeyChecking no" -o "$VIA_BASTION" "ubuntu@$vault_ip" \
    vault operator init \
      -recovery-shares=1 \
      -recovery-threshold=1 \
      -format=json)

  token=$(echo "$init_response" | jq -r '.root_token')

  log "INFO" "Root Token: $token"

  echo "$token" > "$TOKEN_FILE"
}

run_cloud_init() {
  local -r ip="$1"

  ssh -o "StrictHostKeyChecking no" -o "$VIA_BASTION" "ubuntu@$ip" <<EOF
sudo chmod +x /var/lib/cloud/instance/user-data.txt
sudo /var/lib/cloud/instance/user-data.txt
EOF

}

restart_cluster() {
  local -r cluster="$1"

  for ip in $(lookup_private_ips "$cluster"); do

    log "INFO" "Re-initialising $cluster $ip"
    run_cloud_init "$ip"
    sleep 5s

  done

  log "INFO" "Sleeping 10 seconds to wait for restabilisation"
  sleep 10s

  log "INFO" "Done."
}



# ============================================================================ #

mapfile -t vault_ips < <(lookup_private_ips "vault")
mapfile -t nomad_ips < <(lookup_private_ips "nomad")

./scripts/create-vault-cert \
  --vault-ips "${vault_ips[*]}"

./scripts/replace-vault-certs \
  --bastion-ip "$BASTION_IP" \
  --vault-ips "${vault_ips[*]}"


initialise_vault "${vault_ips[0]}"
sleep 10s

./scripts/configure-vault \
  --bastion-ip "$BASTION_IP" \
  --vault-ip "${vault_ips[0]}" \
  --vault-token "$(cat "$TOKEN_FILE")"

sleep 10s

restart_cluster "consul"
restart_cluster "vault"
restart_cluster "nomad"

./scripts/configure-nomad \
  --bastion-ip "$BASTION_IP" \
  --nomad-ip "${nomad_ips[0]}"

restart_cluster "nomad-client*"   # wildcard as we might have multiple client clusters

./scripts/start-nomad-jobs \
  --bastion-ip "$BASTION_IP" \
  --nomad-ip "${nomad_ips[0]}" \
  --vault-token "$(cat "$TOKEN_FILE")"
