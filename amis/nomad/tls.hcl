tls {
  http  = true
  rpc   = true

  ca_file   = "/opt/nomad/tls/ca.crt.pem"
  cert_file = "/opt/nomad/tls/nomad.crt.pem"
  key_file  = "/opt/nomad/tls/nomad.key.pem"
}
