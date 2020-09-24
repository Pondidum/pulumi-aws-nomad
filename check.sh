#!/bin/bash

readonly SCRIPT_NAME="$(basename "$0")"

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

wait_for_cluster_ips() {

    mapfile -t ips < <(get_vault_ips)
    echo "${ips[@]}"


}
node_check_status() {

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

node_check_cluster() {
  local vault_ip="$1"
  response=$(ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" "vault status")

  ha_mode=$(echo "$response" | sed -n 's/HA Mode\s*\(.*\)/\1/p')
  ha_cluster=$(echo "$response" | sed -n 's/HA Cluster\s*\(.*\)/\1/p')

  log "INFO" "Vault $vault_ip is HA: $ha_mode, in cluster $ha_cluster"
}

node_check_cert() {
  local vault_ip="$1"

  local -r cert_command="sudo openssl x509 -in /opt/vault/tls/vault.crt.pem -noout -text -certopt no_subject,no_header,no_version,no_serial,no_signame,no_validity,no_issuer,no_pubkey,no_sigdump,no_aux"
  local -r cert_response=$(ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" "$cert_command")
  local -r cert_addresses=$(echo "$cert_response" | sed -n '/DNS:/p' | sed -r 's/IP Address://g;s/DNS://g' | xargs)

  local -r private_ip=$(ssh -o "StrictHostKeyChecking no" "ubuntu@$vault_ip" "hostname --all-ip-addresses" | xargs)

  local -r cert_has_private_ip=$([[ "$cert_addresses" =~ $private_ip ]] && echo true || echo false)

  log "INFO" "Vault $vault_ip certificate contains private ip: $cert_has_private_ip"
}

run() {

  local check_cluster="false"
  local check_vault="false"
  local check_cert="false"

  while [[ $# -gt 0 ]]; do
    local key="$1"

    case "$key" in
      --cluster)
        check_cluster="true"
        ;;
      --vault)
        check_vault="true"
        ;;
      --certificate)
        check_cert="true"
        ;;
      # --port)
      #   assert_not_empty "$key" "$2"
      #   port="$2"
      #   shift
      #   ;;
      # --help)
      #   print_usage
      #   exit
      #   ;;
      *)
        log "ERROR" "Unrecognized argument: $key"
        exit 1
        ;;
    esac

    shift
  done

  vault_ips=$(wait_for_cluster_ips)

  if [[ "$check_vault" == "true" ]]; then

    local server_ip
    for server_ip in $vault_ips; do
      node_check_status "$server_ip"
    done

  fi

  if [[ "$check_cluster" == "true" ]]; then

    local server_ip
    for server_ip in $vault_ips; do
      node_check_cluster "$server_ip"
    done

  fi

  if [[ "$check_cert" == "true" ]]; then

    local server_ip
    for server_ip in $vault_ips; do
      node_check_cert "$server_ip"
    done

  fi

}

run "$@"