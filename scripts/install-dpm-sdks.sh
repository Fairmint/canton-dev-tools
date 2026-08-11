#!/usr/bin/env bash
# Install Daml Package Manager (dpm) SDKs listed in daml.yaml files under the repo root.
# Migrated from canton-assets / daml (identical). MIT-licensed in this package.
set -euo pipefail

# Prefer multi-package.yaml package entries (supports nested paths). Fall back to a
# pruned filesystem scan that still reaches nested packages while skipping build/vendor trees.
collect_daml_yaml_files() {
  if [ -f multi-package.yaml ]; then
    local package_dir=""
    while IFS= read -r package_dir; do
      [ -n "$package_dir" ] || continue
      if [ -f "${package_dir}/daml.yaml" ]; then
        printf '%s\0' "${package_dir}/daml.yaml"
      fi
    done < <(
      awk '
        /^packages:/ { in_packages=1; next }
        in_packages && /^[[:space:]]*-[[:space:]]+/ {
          line=$0
          sub(/^[[:space:]]*-[[:space:]]+/, "", line)
          sub(/[[:space:]]+#.*$/, "", line)
          gsub(/["'\'']/, "", line)
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
          if (length(line) > 0) print line
          next
        }
        in_packages && /^[^[:space:]#]/ { in_packages=0 }
      ' multi-package.yaml
    )
    return
  fi

  find . \
    \( -name .git -o -name node_modules -o -name generated -o -name .daml -o -name libs -o -name dist -o -name coverage \) \
    -type d -prune \
    -o -name daml.yaml -print0
}

sdk_versions=$(
  collect_daml_yaml_files \
    | xargs -0 awk '/^sdk-version:/ { print $2 }' \
    | sort -u
)

if [ -z "$sdk_versions" ]; then
  echo "No Daml SDK versions found in daml.yaml files" >&2
  exit 1
fi

export PATH="$HOME/.dpm/bin:$PATH"
install_marker_dir="$HOME/.dpm/cache/fairmint-sdk-installs"

echo "Installing Daml SDK versions: $(echo "$sdk_versions" | tr '\n' ' ')"
while IFS= read -r sdk_version; do
  [ -n "$sdk_version" ] || continue

  install_marker="$install_marker_dir/$sdk_version"
  if [ -x "$HOME/.dpm/bin/dpm" ] && [ -f "$install_marker" ]; then
    echo "Daml SDK $sdk_version already installed from cache; skipping"
    continue
  fi

  for attempt in 1 2 3; do
    echo "Installing Daml SDK $sdk_version (attempt $attempt)..."
    if curl -sSL https://get.digitalasset.com/install/install.sh | sh -s "$sdk_version"; then
      mkdir -p "$install_marker_dir"
      date -u +"%Y-%m-%dT%H:%M:%SZ" > "$install_marker"
      echo "Daml SDK $sdk_version installed successfully"
      break
    fi

    if [ "$attempt" -eq 3 ]; then
      echo "Failed to install Daml SDK $sdk_version after 3 attempts" >&2
      exit 1
    fi

    sleep 5
  done
done <<< "$sdk_versions"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$HOME/.dpm/bin" >> "$GITHUB_PATH"
fi
