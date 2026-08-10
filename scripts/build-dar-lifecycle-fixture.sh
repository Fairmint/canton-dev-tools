#!/usr/bin/env bash
# Build the internal DAR lifecycle fixture when dpm is available.
# Unit CI skips cleanly when dpm is missing (exit 0).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${ROOT}/fixtures/dar-lifecycle"

if ! command -v dpm >/dev/null 2>&1; then
  printf '[fixture:dar-lifecycle] dpm not found on PATH; skipping DAR build (CI unit path).\n' >&2
  printf '[fixture:dar-lifecycle] TODO(ENG-1635): install dpm in a dedicated CI job and build this fixture.\n' >&2
  exit 0
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
printf '[fixture:dar-lifecycle] TODO(ENG-1635): upload / vet / breaking-upgrade scenarios against LocalNet.\n'
