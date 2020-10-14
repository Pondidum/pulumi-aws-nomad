{ pkgs ? import <nixpkgs> {} }:
  pkgs.mkShell {
    buildInputs = [
      # pkgs.ssh
      pkgs.curl
      pkgs.awscli2

      pkgs.packer
      pkgs.nomad
      pkgs.vault
      pkgs.docker
      pkgs.jq

      pkgs.pulumi-bin
    ];
}
