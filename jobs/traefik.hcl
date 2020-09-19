job "traefik" {
  datacenters = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  type        = "service"

  group "loadbalancers" {
    count = 1

    task "traefik" {
      driver = "docker"

      config {
        image = "traefik:v2.3"

        args = [
          "--api.insecure=true",
          "--providers.consulcatalog.endpoint.address=http://${attr.unique.network.ip-address}:8500",
          "--providers.consulcatalog.exposedbydefault=false"
        ]

        port_map {
          http = 80
          ui   = 8080
        }
      }

      resources {
        network {
          port "http" { static = 80 }
          port "ui" { static = 8080 }
        }

        memory = 50
      }

      service {
        name = "traefik"
        port = "ui"
        tags = ["ui"]
      }

      service {
        name = "traefik"
        port = "http"
        tags = ["http"]
      }

      constraint {
        attribute = "${meta.traefik}"
        value     = "true"
      }

    }
  }
}
