job "counting" {
  datacenters = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
  type        = "service"

  group "counters" {
    count = 1

    task "counter" {
      driver = "docker"

      config {
        image = "hashicorp/counting-service:0.0.2"

        port_map {
          http = 9001
        }
      }

      resources {
        network {
          port "http" {}
        }

        memory = 50
      }

      service {
        name = "counter"
        port = "http"

        tags = [
          "traefik.enable=true",
          "traefik.http.routers.router0.rule=PathPrefix(`/count`)"
        ]
      }


      constraint {
        attribute = "${meta.traefik}"
        operator  = "!="
        value     = "true"
      }

    }
  }
}
