#!/usr/bin/env bash
# Build the internal DAR lifecycle fixture. Fails closed if dpm is missing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${ROOT}/fixtures/dar-lifecycle"

if ! command -v dpm >/dev/null 2>&1; then
  printf '[fixture:dar-lifecycle] dpm not found on PATH; install the Daml Package Manager and retry.\n' >&2
  exit 1
fi

if [[ ! -f "${FIXTURE_DIR}/daml.yaml" ]]; then
  printf '[fixture:dar-lifecycle] missing daml.yaml at %s\n' "${FIXTURE_DIR}" >&2
  exit 1
fi

printf '[fixture:dar-lifecycle] building DAR with dpm...\n'
(
  cd "${FIXTURE_DIR}"
  dpm build
)

printf '[fixture:dar-lifecycle] build complete.\n'
