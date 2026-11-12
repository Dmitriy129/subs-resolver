#!/usr/bin/env bash
set -eo pipefail

# Run as the user who will own and run the application, after cloning the repo.
if [[ "$(uname -s)" != Linux ]] || ! command -v apt-get >/dev/null 2>&1; then
  printf '%s\n' 'This installer requires Ubuntu (or another Debian-based Linux).' >&2
  exit 1
fi

task_project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$task_project_dir"

# Only system prerequisites need root; Node and package managers stay in NVM.
if ! command -v curl >/dev/null 2>&1 || [[ ! -s /etc/ssl/certs/ca-certificates.crt ]]; then
  task_sudo=()
  if (( EUID != 0 )); then
    if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true; then
      printf '%s\n' 'Install prerequisites with: sudo apt-get update && sudo apt-get install -y curl ca-certificates' >&2
      printf '%s\n' 'Then rerun this script as your application user.' >&2
      exit 1
    fi
    task_sudo=(sudo -n)
  fi
  "${task_sudo[@]}" apt-get update
  "${task_sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates
fi

task_nvm_version=v0.41.0
task_corepack_version=0.36.0
task_default_nvm_dir="$HOME/.nvm"
if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
  task_default_nvm_dir="$XDG_CONFIG_HOME/nvm"
fi
export NVM_DIR="${NVM_DIR:-$task_default_nvm_dir}"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  mkdir -p -- "$NVM_DIR"
  task_nvm_installer=$(mktemp)
  trap 'rm -f -- "$task_nvm_installer"' EXIT
  curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${task_nvm_version}/install.sh" -o "$task_nvm_installer"
  PROFILE=/dev/null METHOD=script NVM_INSTALL_VERSION="$task_nvm_version" bash "$task_nvm_installer"
fi

# NVM is a shell function, and child scripts do not inherit interactive profiles.
# Do not enable nounset: NVM supports shells with unset optional variables.
source "$NVM_DIR/nvm.sh" --no-use || exit $?
nvm install || exit $?
nvm use || exit $?

npm install --global "corepack@$task_corepack_version"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable pnpm
corepack install
pnpm install --frozen-lockfile --prod=false
pnpm run setup
pnpm build

printf '\nInstalled and built. To start in your current shell:\n'
printf '  export NVM_DIR=%q\n' "$NVM_DIR"
printf '  . "$NVM_DIR/nvm.sh"\n'
printf '  cd %q\n' "$task_project_dir"
printf '  nvm use\n  pnpm start\n'
