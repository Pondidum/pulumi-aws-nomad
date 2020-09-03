#!/bin/bash

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for path in "$SCRIPT_DIR"/*/*.json; do

  pushd "$(dirname "$path")" &> /dev/null

  packer build "$(basename "$path")"

  popd &> /dev/null

done
