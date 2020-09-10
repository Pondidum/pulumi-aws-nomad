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

lookup_public_ips() {
  local -r cluster_tag_value="$1"
  local -r cluster_tag="Name"
  local -r region="eu-west-1"

  local -r ips=$(aws ec2 describe-instances \
    --region "$region" \
    --filter "Name=tag:$cluster_tag,Values=$cluster_tag_value" "Name=instance-state-name,Values=running" \
    | jq -r '.Reservations[].Instances[].PublicIpAddress')

  echo "$ips"
}



get_vault_private_ips() {

  local region="eu-west-1"
  local cluster_tag="Name"
  local cluster_tag_value="vault"

  instances=$(aws ec2 describe-instances \
  --region "$region" \
  --filter "Name=tag:$cluster_tag,Values=$cluster_tag_value" "Name=instance-state-name,Values=running")

  echo "$instances" | jq -r '.Reservations[].Instances[].PrivateIpAddress'
}


wait_for_cluster_ips() {

  local cluster_size=3
  local max_retries=30
  local wait_time=10

  for (( i=1; i<="$max_retries"; i++ )); do
    mapfile -t ips < <(lookup_public_ips "vault")

    if [[ "${#ips[@]}" -eq "$cluster_size" ]]; then
      echo "${ips[@]}"
      return
    fi

    log "WARN" "Found ${#ips[@]} servers, but want $cluster_size. Sleeping for $wait_time seconds."
    sleep "${wait_time}s"
  done

  log "ERROR" "Failed to find $cluster_size ip addresses after $max_retries retries"
  exit 1

}

check_vault_ready() {

  local vault_ip="$1"
  local vault_health_url="https://localhost:8200/v1/sys/health"

  local max_retries=30
  local wait_time=10

  local curl_command="curl --show-error --location --insecure --silent --write-out \"HTTPSTATUS:%{http_code}\" \"$vault_health_url\" || true"


  for (( i=1; i<="$max_retries"; i++ )); do

    response=$(ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" "$curl_command")
    status=$(echo "$response" | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    # body=$(echo "$response" | sed -e 's/HTTPSTATUS\:.*//g')

    if [[ "$status" -eq 200 ]]; then
      log "INFO" "Vault server $vault_ip is initialized, unsealed, and active."
      return
    elif [[ "$status" -eq 429 ]]; then
      log "INFO" "Vault server $vault_ip is unsealed and in standby mode."
      return
    elif [[ "$status" -eq 501 ]]; then
      log "INFO" "Vault server $vault_ip is uninitialized."
      return
    elif [[ "$status" -eq 503 ]]; then
      log "INFO" "Vault server $vault_ip is sealed."
      return
    else
      log "INFO" "Vault server $vault_ip returned unexpected status code $status. Will sleep for $wait_time seconds and check again."
      sleep "${wait_time}s"
    fi
  done

  log "ERROR" "Didn't get a successful response for server $vault_ip after $max_retries retries"
  exit 1
}

wait_for_cluster() {

  local -r server_ips="$1"

  local server_ip
  for server_ip in $server_ips; do
    check_vault_ready "$server_ip"
  done

  log "INFO" "All servers are healthy"
}

generate_cluster_certificate() {

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

  local -r ip_csv="$(get_vault_private_ips | xargs | sed 's/ /,/g'),127.0.0.1"

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

  local vault_ip
  for vault_ip in $vault_ips; do

    scp -o "StrictHostKeyChecking no" $TLS_PATH/cluster.* "ubuntu@$vault_ip:/tmp"
    ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" << EOF

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

  init_response=$(ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" vault operator init -recovery-shares=1 -recovery-threshold=1 -format=json)
  token=$(echo "$init_response" | jq -r '.root_token')

  log "INFO" "Root Token: $token"

  echo "$token" > "$TOKEN_FILE"
}

configure_vault() {
  read -ra ips <<< "$1"
  local -r vault_ip="${ips[0]}"

  log "INFO" "Configuring Vault on $vault_ip"
  # copy the vault configuration to the machine, along with some certificates
  scp -o "StrictHostKeyChecking no" -r ./configuration/vault "ubuntu@$vault_ip:/tmp/configure"
  scp -o "StrictHostKeyChecking no" ./configuration/tls/int.* "ubuntu@$vault_ip:/tmp/configure/tls/"

  local -r token=$(cat "$TOKEN_FILE")

  ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" <<EOF

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
  mapfile -t ips < <(lookup_public_ips "nomad")
  local -r nomad_ip="${ips[0]}"

  log "INFO" "Configuring Nomad on $nomad_ip"

  scp -o "StrictHostKeyChecking no" -r ./configuration/nomad "ubuntu@$nomad_ip:/tmp/configure"

  ssh -o "StrictHostKeyChecking no" "ubuntu@$nomad_ip" <<"EOF"

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

  ssh -o "StrictHostKeyChecking no" "ubuntu@$ip" <<EOF
sudo chmod +x /var/lib/cloud/instance/user-data.txt
sudo /var/lib/cloud/instance/user-data.txt
EOF

}

restart_cluster() {
  local -r cluster="$1"

  for ip in $(lookup_public_ips "$cluster"); do

    log "INFO" "Re-initialising $cluster $ip"
    run_cloud_init "$ip"
    sleep 5s

  done

  log "INFO" "Sleeping 10 seconds to wait for restabilisation"
  sleep 10s

  log "INFO" "Done."
}


# vault_ips=$(wait_for_cluster_ips)

# wait_for_cluster "$vault_ips"

# generate_cluster_certificate
# replace_cluster_certificates "$vault_ips"

# initialise_vault "$vault_ips"
# sleep 10s

# configure_vault "$vault_ips"
# sleep 10s

# restart_cluster "consul"
# restart_cluster "vault"
# restart_cluster "nomad"
# restart_cluster "nomad-client"

configure_nomad
