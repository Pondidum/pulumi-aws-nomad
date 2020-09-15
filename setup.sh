#!/bin/bash

set -e

readonly TLS_PATH="./configuration/tls/"
readonly TOKEN_FILE=".root_token"
readonly SCRIPT_NAME="$(basename "$0")"

export AWS_PROFILE="personal"

log() {

  local readonly level="$1"
  local readonly message="$2"
  local readonly timestamp=$(date +"%Y-%m-%d %H:%M:%S")

  >&2 echo -e "${timestamp} [${level}] [$SCRIPT_NAME] ${message}"
}

readonly BASTION_IP=$(aws ec2 describe-instances \
    --region "eu-west-1" \
    --filter "Name=tag:Name,Values=bastion" "Name=instance-state-name,Values=running" \
    | jq -r '.Reservations[].Instances[0].PublicIpAddress')

log "INFO" "Bastion is at $BASTION_IP"

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

generate_cluster_certificate() {
  local -r vault_ips="$1"

  local -r pem=$(cat "$TLS_PATH/int.crt" "$TLS_PATH/int.key")


  log "INFO" "Starting local intermediate CA"

  container=$(docker run -d --rm --cap-add=IPC_LOCK -p 8200:8200 -e "VAULT_DEV_ROOT_TOKEN_ID=vault" vault:latest)
  sleep 2s

  export VAULT_ADDR="http://localhost:8200"
  export VAULT_TOKEN="vault"

  vault secrets enable pki
  vault write pki/config/ca pem_bundle="$pem"

  vault write pki/roles/cert \
    allowed_domains="localhost,consul" \
    allow_subdomains=true \
    max_ttl=43800h

  local -r ip_csv="$(echo "$vault_ips" | xargs | sed 's/ /,/g'),127.0.0.1"

  log "INFO" "Generating cluster certificate"
  log "INFO" "IP Csv: $ip_csv"


  cert=$(vault write pki/issue/cert -format=json common_name="vault.service.consul" alt_names="localhost" ip_sans="$ip_csv")

  echo "$cert" | jq -r .data.private_key > "$TLS_PATH/cluster.key"
  echo "$cert" | jq -r .data.certificate > "$TLS_PATH/cluster.crt"
  echo "$cert" | jq -r .data.issuing_ca >> "$TLS_PATH/cluster.crt"

  docker stop "$container"

  log "INFO" "Cluster certificates written to $TLS_PATH/cluster.[crt,key]"
}

replace_cluster_certificates() {
  local -r vault_ips="$1"


# scp -o "ProxyCommand ssh ubuntu@3.249.103.170 -W %h:%p" readme.md  ubuntu@192.168.79.52:/tmp

  local vault_ip
  for vault_ip in $vault_ips; do

    scp -o "StrictHostKeyChecking no" -o "$VIA_BASTION" $TLS_PATH/cluster.* "ubuntu@$vault_ip:/tmp"
    ssh -o "StrictHostKeyChecking no" -o "$VIA_BASTION" "ubuntu@$vault_ip" << EOF

sudo mv /tmp/cluster.crt /opt/vault/tls/vault.crt.pem
sudo mv /tmp/cluster.key /opt/vault/tls/vault.key.pem
sudo chown -R vault:vault /opt/vault/tls

sudo pkill -HUP vault
EOF

  done
}

initialise_vault() {
  read -ra ips <<< "$1"
  local -r vault_ip="${ips[0]}"

  init_response=$(ssh -o "StrictHostKeyChecking no" -o "$VIA_BASTION" "ubuntu@$vault_ip" \
    vault operator init \
      -recovery-shares=1 \
      -recovery-threshold=1 \
      -format=json)

  token=$(echo "$init_response" | jq -r '.root_token')

  log "INFO" "Root Token: $token"

  echo "$token" > "$TOKEN_FILE"
}

configure_vault() {
  read -ra ips <<< "$1"
  local -r vault_ip="${ips[0]}"

  log "INFO" "Configuring Vault on $vault_ip"
  # copy the vault configuration to the machine, along with some certificates
  scp -o "StrictHostKeyChecking no" -o "$VIA_BASTION"  -r ./configuration/vault "ubuntu@$vault_ip:/tmp/configure"
  scp -o "StrictHostKeyChecking no" -o "$VIA_BASTION" ./configuration/tls/int.* "ubuntu@$vault_ip:/tmp/configure/tls/"

  local -r token=$(cat "$TOKEN_FILE")

  ssh -o "StrictHostKeyChecking no" -o "$VIA_BASTION" "ubuntu@$vault_ip" <<EOF

export VAULT_TOKEN="$token"

/tmp/configure/configure.sh \
  --domains "localhost,consul" \
  --vault-role-arn "$(pulumi stack output vaultRole)" \
  --consul-role-arn "$(pulumi stack output consulRole)" \
  --nomad-server-role-arn "$(pulumi stack output nomadServerRole)" \
  --nomad-client-role-arn "$(pulumi stack output nomadClientRole)"

rm -rf /tmp/configure
EOF

}

configure_nomad() {
  mapfile -t ips < <(lookup_private_ips "nomad")
  local -r nomad_ip="${ips[0]}"

  log "INFO" "Configuring Nomad on $nomad_ip"

  scp -o "StrictHostKeyChecking no" -o "$VIA_BASTION" -r ./configuration/nomad "ubuntu@$nomad_ip:/tmp/configure"

  ssh -o "StrictHostKeyChecking no" -o "$VIA_BASTION" "ubuntu@$nomad_ip" <<"EOF"

sudo rm ~/.vault-token

export NOMAD_ADDR="https://127.0.0.1:4646"
export VAULT_ADDR=$(/opt/vault/bin/find-vault)

vault login -method=aws role="nomad-server"

/tmp/configure/configure.sh

rm -rf /tmp/configure

EOF

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

vault_ips=$(lookup_private_ips "vault")

generate_cluster_certificate "$vault_ips"
replace_cluster_certificates "$vault_ips"
initialise_vault "$vault_ips"

sleep 10s

configure_vault "$vault_ips"
sleep 10s

restart_cluster "consul"
restart_cluster "vault"
restart_cluster "nomad"

configure_nomad
restart_cluster "nomad-client"
