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

get_vault_ips() {

  local region="eu-west-1"
  local cluster_tag="Name"
  local cluster_tag_vaule="vault"

  instances=$(aws ec2 describe-instances \
  --region "$region" \
  --filter "Name=tag:$cluster_tag,Values=$cluster_tag_vaule" "Name=instance-state-name,Values=running")

  echo "$instances" | jq -r '.Reservations[].Instances[].PublicIpAddress'
}

get_vault_private_ips() {

  local region="eu-west-1"
  local cluster_tag="Name"
  local cluster_tag_vaule="vault"

  instances=$(aws ec2 describe-instances \
  --region "$region" \
  --filter "Name=tag:$cluster_tag,Values=$cluster_tag_vaule" "Name=instance-state-name,Values=running")

  echo "$instances" | jq -r '.Reservations[].Instances[].PrivateIpAddress'
}


wait_for_cluster_ips() {

  local cluster_size=3
  local max_retries=30
  local wait_time=10

  for (( i=1; i<="$max_retries"; i++ )); do
    mapfile -t ips < <(get_vault_ips)

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

  echo "$server_ips"
}

generate_cluster_certificate() {

  local -r pem=$(cat "$TLS_PATH/int.crt" "$TLS_PATH/int.key")

  mapfile -t ips < <(get_vault_private_ips)
  local -r ip_csv="${ips//\n/,},127.0.0.1"

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

  log "INFO" "Generating cluster certificate"

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

join_cluster_nodes() {
  read -ra ips <<< "$1"

  log "INFO" "Waiting to form cluster"


  # skip the first item, as it is the leader
  for ip in "${ips[@]:1}"; do
    log "INFO" "Joining node $ip"
    ssh -o "StrictHostKeyChecking no" "ubuntu@$ip" vault operator raft join
  done

  log "INFO" "Cluster joined"
}

configure_vault() {
  read -ra ips <<< "$1"
  local -r vault_ip="${ips[0]}"

  log "INFO" "Configuring Vault on $ip"
  # copy the vault configuration to the machine, along with some certificates
  scp -o "StrictHostKeyChecking no" -r ./configuration/vault "ubuntu@$vault_ip:/tmp/configure"
  scp -o "StrictHostKeyChecking no" ./configuration/tls/int.* "ubuntu@$vault_ip:/tmp/configure/tls/"

  local -r token=$(cat "$TOKEN_FILE")

  ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" <<EOF

export VAULT_TOKEN="$token"

/tmp/configure/configure.sh \
  --domains "localhost,consul" \
  --iam-login-role "$(pulumi stack output roleArn)"

rm -rf /tmp/configure
EOF

}

vault_ips=$(wait_for_cluster_ips)

wait_for_cluster "$vault_ips"

generate_cluster_certificate
replace_cluster_certificates "$vault_ips"

initialise_vault "$vault_ips"
sleep 10s
join_cluster_nodes "$vault_ips"

sleep 10s
configure_vault "$vault_ips"
