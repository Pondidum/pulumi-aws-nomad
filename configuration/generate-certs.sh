#!/bin/bash
set -euo pipefail

container=$(docker run -d --rm  --cap-add=IPC_LOCK -p 8200:8200 -e "VAULT_DEV_ROOT_TOKEN_ID=vault" vault:latest)
sleep 2s

export VAULT_ADDR="http://localhost:8200"
export VAULT_TOKEN="vault"

# create root ca
certs_dir="/keybase/private/pondidum/dev-ca"
out_dir="./tls"

rm -rf "$out_dir"
mkdir -p "$out_dir"

pem=$(cat $certs_dir/ca.crt $certs_dir/private.key)

vault secrets enable -path=pki_root pki
vault secrets tune -max-lease-ttl=87600h pki_root
vault write pki_root/config/ca pem_bundle="$pem"

# create the intermediate
vault secrets enable pki
vault secrets tune -max-lease-ttl=43800h pki

csr_response=$(vault write pki/intermediate/generate/exported \
  -format=json common_name="Spectre Dev Intermdiate CA")

csr=$(echo "$csr_response" | jq -r .data.csr)

intermediate=$(vault write pki_root/root/sign-intermediate \
  -format=json csr="$csr" format=pem_bundle ttl=43800h \
  | jq -r .data.certificate)

chained=$(echo -e "$intermediate\n$(cat $certs_dir/ca.crt)")

vault write pki/intermediate/set-signed certificate="$chained"

echo "$intermediate" > "$out_dir/int.crt"
echo "$csr_response" | jq -r .data.private_key > "$out_dir/int.key"

vault write pki/roles/cert \
  allowed_domains=localhost,mshome.net \
  allow_subdomains=true \
  max_ttl=43800h

# destroy the temp root
vault secrets disable pki_root



cert=$(vault write pki/issue/cert \
  -format=json \
  common_name="localhost" \
  ip_sans="127.0.0.1")

cp "$certs_dir/ca.crt" "$out_dir/ca.crt"
echo "$cert" | jq -r .data.private_key > "$out_dir/localhost.key"
echo "$cert" | jq -r .data.certificate > "$out_dir/localhost.crt"
echo "$cert" | jq -r .data.issuing_ca >> "$out_dir/localhost.crt"

docker stop "$container"
