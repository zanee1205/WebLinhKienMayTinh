#!/usr/bin/env bash
set -eo pipefail

# Wrapper to run the Salesforce sync script.
# Behavior:
# - If a Docker container named `zanee-backend` is running, exec into it and run the sync.
# - Otherwise run the sync using the host node (assumes Node and repo are on host).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER_NAME="zanee-backend"

if docker ps --filter "name=${CONTAINER_NAME}" --format '{{.Names}}' | grep -q "${CONTAINER_NAME}"; then
  echo "Running sync inside container ${CONTAINER_NAME}"
  docker exec -it ${CONTAINER_NAME} node src/salesforceSync.js
else
  echo "Running sync from host (requires node in PATH)"
  cd "$REPO_ROOT/backend"
  node src/salesforceSync.js
fi
