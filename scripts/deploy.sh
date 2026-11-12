#!/usr/bin/env bash
set -euo pipefail

{ # Parse the whole download before running; subprocesses must not consume it.
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
task_domain=''
while (( $# )); do
  case "$1" in
    --domain) (( $# >= 2 )) || fail '--domain requires a hostname'; task_domain=$2; shift 2 ;;
    -h|--help) printf 'Usage: sudo bash deploy.sh --domain resolver.example.com\n'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
task_domain=${task_domain,,}
task_domain_pattern='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
[[ ${#task_domain} -le 253 && $task_domain =~ $task_domain_pattern ]] || fail 'Provide --domain with a DNS hostname, without a scheme, port or path.'
(( EUID == 0 )) || fail 'Run this installer through sudo bash.'
[[ -f /etc/os-release ]] || fail 'Ubuntu or Debian is required.'
# shellcheck disable=SC1091
source /etc/os-release
case ${ID:-} in
  ubuntu|debian) ;;
  *) fail 'This deployment installer supports Ubuntu and Debian.' ;;
esac
[[ -d /run/systemd/system ]] || fail 'A running systemd system is required.'
getent ahosts "$task_domain" >/dev/null || fail 'The domain has no resolvable A/AAAA record. Point DNS to this server before deploying.'

task_repo_url=https://github.com/Dmitriy129/subs-resolver.git
task_repo=/opt/subs-resolver
task_user=subs-resolver
task_home=/var/lib/subs-resolver
task_unit=/etc/systemd/system/subs-resolver.service
task_site=/etc/caddy/sites/subs-resolver.caddy
task_caddyfile=/etc/caddy/Caddyfile
task_marker='# Managed by subs-resolver deploy.sh'
task_tmp=$(mktemp -d)
task_restore_caddy=0
task_site_existed=0
cleanup() {
  if (( task_restore_caddy )); then
    cp -p -- "$task_tmp/Caddyfile.original" "$task_caddyfile"
    if (( task_site_existed )); then cp -p -- "$task_tmp/site.original" "$task_site"; else rm -f -- "$task_site"; fi
  fi
  rm -rf -- "$task_tmp"
}
trap cleanup EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates git iproute2 ufw gnupg debian-keyring debian-archive-keyring apt-transport-https

# Refuse to replace other servers, including Caddy instances outside caddy.service.
check_listener() {
  local task_port=$1 task_service=$2 task_pid task_line task_found task_listeners
  task_pid=$(systemctl show "$task_service" -p MainPID --value 2>/dev/null || true)
  task_listeners=$(ss -H -ltnp "sport = :$task_port" && ss -H -lunp "sport = :$task_port") || fail "Cannot inspect port $task_port."
  while IFS= read -r task_line; do
    [[ -z $task_line ]] && continue
    task_found=$(printf '%s\n' "$task_line" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
    [[ -n $task_found && $task_pid != 0 && $task_found == "$task_pid" ]] || fail "Port $task_port is occupied by another service. Nothing will be stopped."
  done <<< "$task_listeners"
}
check_listener 80 caddy.service
check_listener 443 caddy.service
check_listener 3000 subs-resolver.service
if systemctl is-active --quiet caddy-api.service; then fail 'caddy-api.service is active; refusing to replace its configuration.'; fi
if [[ -e $task_unit ]] && ! grep -Fqx "$task_marker" "$task_unit"; then fail "$task_unit already exists and is not managed by this installer."; fi
if [[ -e $task_site ]] && ! grep -Fqx "$task_marker" "$task_site"; then fail "$task_site already exists and is not managed by this installer."; fi
[[ ! -L $task_unit && ! -L $task_site ]] || fail 'Managed configuration paths must not be symbolic links.'

# Discover configured AND actual SSH ports before changing firewall policy.
{
  /usr/sbin/sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' || true
  if [[ -n ${SSH_CONNECTION:-} ]]; then printf '%s\n' "$SSH_CONNECTION" | awk '{print $4}'; fi
  ss -H -atnp | awk '/"sshd/ {port=$4; sub(/^.*:/, "", port); print port}'
  systemctl show ssh.socket -p Listen --value 2>/dev/null | grep -oE ':[0-9]+ ' | tr -cd '0-9\n' || true
} | awk '/^[0-9]+$/ && $0 >= 1 && $0 <= 65535' | sort -nu > "$task_tmp/ssh-ports"
[[ -s $task_tmp/ssh-ports ]] || fail 'Cannot determine the SSH port; refusing to enable the firewall.'

if ! command -v caddy >/dev/null 2>&1; then
  if [[ ! -e /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]]; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$task_tmp/caddy.key"
    gpg --batch --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg "$task_tmp/caddy.key"
    chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  fi
  if [[ ! -e /etc/apt/sources.list.d/caddy-stable.list ]]; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$task_tmp/caddy.list"
    install -m 644 "$task_tmp/caddy.list" /etc/apt/sources.list.d/caddy-stable.list
  fi
  apt-get update
  apt-get install -y --no-install-recommends caddy
fi
task_caddy_start=$(systemctl show caddy.service -p ExecStart --value)
[[ $task_caddy_start == *'--config /etc/caddy/Caddyfile'* ]] || fail 'Caddy must use the standard caddy.service and /etc/caddy/Caddyfile.'
[[ -f $task_caddyfile && ! -L $task_caddyfile ]] || fail 'Expected a regular /etc/caddy/Caddyfile.'

if id "$task_user" >/dev/null 2>&1; then
  [[ $(getent passwd "$task_user" | cut -d: -f6) == "$task_home" && $(id -gn "$task_user") == "$task_user" && $(id -u "$task_user") != 0 ]] || fail 'The existing subs-resolver account has conflicting settings.'
else
  useradd --system --user-group --create-home --home-dir "$task_home" --shell /usr/sbin/nologin "$task_user"
fi
as_app() { runuser -u "$task_user" -- env -i HOME="$task_home" USER="$task_user" LOGNAME="$task_user" PATH=/usr/local/bin:/usr/bin:/bin NVM_DIR="$task_home/.nvm" "$@"; }
if [[ -d $task_repo/.git ]]; then
  [[ $(as_app git -C "$task_repo" remote get-url origin) == "$task_repo_url" ]] || fail 'Existing checkout has a different origin.'
  [[ -z $(as_app git -C "$task_repo" status --porcelain --untracked-files=no) ]] || fail 'The checkout has tracked local changes; resolve them before redeploying.'
  if [[ $(as_app git -C "$task_repo" symbolic-ref --short HEAD) == redirector ]]; then
    as_app git -C "$task_repo" fetch origin main
    as_app git -C "$task_repo" merge-base --is-ancestor HEAD FETCH_HEAD || fail 'The redirector checkout has commits not yet included in main.'
    as_app git -C "$task_repo" switch main
  fi
  [[ $(as_app git -C "$task_repo" symbolic-ref --short HEAD) == main ]] || fail 'Existing checkout must be on main.'
  as_app git -C "$task_repo" pull --ff-only origin main
else
  [[ ! -e $task_repo ]] || fail "$task_repo exists but is not this Git checkout."
  install -d -m 755 -o "$task_user" -g "$task_user" "$task_repo"
  as_app git clone --branch main --single-branch "$task_repo_url" "$task_repo"
fi
as_app bash "$task_repo/scripts/install.sh"
task_node_version=$(tr -d '\r\n' < "$task_repo/.nvmrc")
[[ $task_node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '.nvmrc must contain an exact Node version.'
task_node="$task_home/.nvm/versions/node/v$task_node_version/bin/node"
[[ -x $task_node ]] || fail 'The pinned Node installation is missing.'
as_app env HOST=127.0.0.1 PORT=3000 "$task_node" --env-file="$task_repo/.env" --input-type=module \
  -e "import('file://$task_repo/dist/config.js').then((m) => m.loadConfig())"
task_access_id=$(as_app "$task_node" --env-file="$task_repo/.env" -p '(process.env.ACCESS_ID || "").toLowerCase()')
[[ $task_access_id =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || fail 'setup did not create a valid ACCESS_ID in .env.'

cat > "$task_tmp/subs-resolver.service" <<EOF
$task_marker
[Unit]
Description=Subscription resolver
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$task_user
Group=$task_user
WorkingDirectory=$task_repo
Environment=HOST=127.0.0.1
Environment=PORT=3000
ExecStart=$task_node --env-file=$task_repo/.env $task_repo/dist/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
install -m 644 "$task_tmp/subs-resolver.service" "$task_unit"
systemctl daemon-reload
systemctl enable subs-resolver.service
systemctl restart subs-resolver.service
task_ready=0
for ((task_try=0; task_try<10; task_try++)); do
  if systemctl is-active --quiet subs-resolver.service && [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:3000/$task_access_id/" || true) == 200 ]]; then task_ready=1; break; fi
  sleep 1
done
(( task_ready )) || fail 'The resolver did not start. Check journalctl -u subs-resolver.'

# Keep existing UFW rules; prepend SSH allowances before restrictive defaults.
if grep -Eq '^IPV6=no([[:space:]]|$)' /etc/default/ufw; then
  sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
fi
while IFS= read -r task_port; do ufw prepend allow "$task_port/tcp" comment 'subs-resolver: preserve SSH'; done < "$task_tmp/ssh-ports"
ufw prepend allow 80/tcp comment 'subs-resolver: HTTP challenge'
ufw prepend allow 443/tcp comment 'subs-resolver: HTTPS'
ufw prepend allow 443/udp comment 'subs-resolver: HTTP/3'
ufw default allow outgoing
ufw default deny incoming
ufw --force enable

# Preserve the main Caddyfile; only our marked site can be replaced.
install -d -m 755 /etc/caddy/sites
cp -p -- "$task_caddyfile" "$task_tmp/Caddyfile.original"
if [[ -e $task_site ]]; then task_site_existed=1; cp -p -- "$task_site" "$task_tmp/site.original"; fi
task_restore_caddy=1
cat > "$task_tmp/site.caddy" <<EOF
$task_marker
$task_domain {
    reverse_proxy 127.0.0.1:3000
}
EOF
install -m 644 "$task_tmp/site.caddy" "$task_site"
if ! grep -Fqx "import $task_site" "$task_caddyfile"; then
  printf '\n%s\nimport %s\n' "$task_marker" "$task_site" >> "$task_caddyfile"
fi
caddy validate --config "$task_caddyfile" --adapter caddyfile
systemctl enable caddy.service
if systemctl is-active --quiet caddy.service; then systemctl reload caddy.service; else systemctl start caddy.service; fi
task_restore_caddy=0

printf '\nWaiting for a public HTTPS certificate for %s...\n' "$task_domain"
task_ready=0
for ((task_try=0; task_try<30; task_try++)); do
  if [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$task_domain:443:127.0.0.1" "https://$task_domain/" || true) == 404 ]]; then task_ready=1; break; fi
  sleep 2
done
printf '\nSubscription URL template:\nhttps://%s/%s/?subs=%s&subs=%s\n' "$task_domain" "$task_access_id" \
  'https%3A%2F%2Fvpn-main.example%2Fsub%2FUSER_ID' \
  'https%3A%2F%2Fvpn-backup.example%2Fsubscription%2FBACKUP_ID'
if (( ! task_ready )); then
  fail 'Services are installed, but HTTPS is not ready yet. Point DNS A/AAAA to this server and allow ports 80/443 in the provider firewall; then check journalctl -u caddy.'
fi
printf '\nDeployment ready. Caddy renews HTTPS certificates automatically.\n'
} < /dev/null
