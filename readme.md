## Requirements

Installed locally (on your PATH):

* aws
* jq
* ssh
* pulumi
* docker
* vault
* nomad

In AWS:

* ec2 keypair

## I just want to run it

You must have a keypair in aws to use already, and installed into the correct ssh folder on your machine for this to work.

```bash
./scripts/create-tls-certificates
./scripts/build-amis

pulumi config set nomad-aws:keypair "<your aws keypair name>"
pulumi up
./setup.sh

./scripts/connect
```

Each step is explained in more detail below:

## Detailed Instructions

### 1. Generate TLS Certificates

This command will create the TLS structure we will use:

```bash
./scripts/create-tls-certificates
```

If you already have a certificate to use as the root for this demo, you can place the certificate and key in the following paths:

```
./configuration/tls/ca.crt
./configuration/tls/ca.key
```

The `ca.crt` is copied to the AMIs we will build, and the `ca.key` won't leave your machine.


### 2. Build the AMIs

This demo uses 3 AMIs; Consul, Vault, and Nomad.

They can be built with the following command.  If you're running in a differnt region, specify it with `--region <name>`.

```bash
./scripts/build-amis
```

### 3. Bring up the Infra!

This creates a VPC for the machines to sit in, and 5 clusters:

1. Consul Cluster: 3 machines
2. Vault Cluster: 3 machines
3. Nomad Server Cluster: 3 machines
4. Nomad Client Cluster with LoadBalancer: 1 machine
5. Nomad Client Cluster: 1 machine

```bash
pulumi config set nomad-aws:keypair "<your aws keypair name>"
pulumi up
```

### 4. Configure the Infra!

Once all the machines have started, we can configure them with new certificates, and join clusters together:

```bash
./setup.sh
```

The Vault Root Token will be written to the `.root_token` file.  You should add some user authentication to the Vault instances, so you don't need to use the root token later.

It will also start two jobs in the Nomad clusters: Traefik and a Counter service.

### 5. Connect

All connection can be done through the bastion machine.  There is a script to forward Nomad, Consul, Vault, and Traefik Admin traffic:

```bash
./scripts/connect
```

You can now open these in your browser:

* [Vault](https://localhost:8200)
* [Consul](http://localhost:8500)
* [Nomad](https://localhost:4646)
* [Traefik](http://localhost:8080)

You can also go to your public loadbalancer url, and see the result of the `counter` service running:

```bash
curl http://$(pulumi stack output nomadClientLb)/count
```

### Additional

Create a Nomad token so you can access the UI or use the CLI.  There are two roles configured, `developer` which has access to start and stop jobs, and `operator` who can do everything:

```bash

export NOMAD_CAPATH="$PWD/configuration/tls/ca.crt"
export VAULT_CAPATH="$PWD/configuration/tls/ca.crt"
export VAULT_TOKEN="$(cat .root_token)"

vault read -field secret_id nomad/creds/developer
vault read -field secret_id nomad/creds/operator
```

Stop the counting service:

```bash
export NOMAD_TOKEN=$(vault read -field secret_id nomad/creds/developer)
export NOMAD_ADDR="https://localhost:4646"

nomad job stop jobs/counting.hcl
```


## Todo

- [x] Add readme instructions
- [x] fix keypair usage
- [ ] tls certificate when specified with loadbalancer
- [x] internal tls cert renewal for machines
- [x] add `assert_is_installed` checks to scripts
- [x] add `./scripts/create-ca`