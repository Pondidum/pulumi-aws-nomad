path "pki/issue/*" {
    capabilities = ["create", "update"]
}

path "pki/certs" {
    capabilities = ["list"]
}

path "pki/revoke" {
    capabilities = ["create", "update"]
}

path "pki/tidy" {
    capabilities = ["create", "update"]
}

path "pki/cert/ca" {
    capabilities = ["read"]
}
