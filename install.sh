#!/usr/bin/env bash
# meowmarism PROFESSIONAL installer: installs Node.js and Docker if missing, downloads the latest
# tagged release and sets up a systemd service. Re-running offers update, owner reset and removal.
#
#   curl -fsSL https://raw.githubusercontent.com/meowmarism-official/meowmarism-professional/master/install.sh | bash
set -euo pipefail

if [ -t 1 ]; then
  C_PINK='\033[1;35m'; C_CYAN='\033[36m'; C_GREEN='\033[1;32m'
  C_YELLOW='\033[1;33m'; C_RED='\033[1;31m'; C_DIM='\033[2m'; C_BOLD='\033[1m'; C_RESET='\033[0m'
else
  C_PINK=''; C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_BOLD=''; C_RESET=''
fi
STEP_N=0
step() { STEP_N=$((STEP_N + 1)); printf "${C_CYAN}[%d]${C_RESET} ${C_BOLD}%b${C_RESET}\n" "$STEP_N" "$1"; }
info() { printf "    ${C_DIM}%s${C_RESET}\n" "$1"; }
ok()   { printf "${C_GREEN}==>${C_RESET} %s\n" "$1"; }
warn() { printf "${C_YELLOW}==>${C_RESET} %s\n" "$1"; }
die()  { printf "${C_RED}error:${C_RESET} %s\n" "$1" >&2; exit 1; }
# --- progress helpers: spinner with a check or cross per task, and a download bar ---
if [ -t 1 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*utf8*|*UTF8*) FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏); MARK_OK="✔"; MARK_FAIL="✘"; BAR_FULL="█"; BAR_EMPTY="░" ;;
  *) FRAMES=('-' '\' '|' '/'); MARK_OK="OK"; MARK_FAIL="FAILED"; BAR_FULL="#"; BAR_EMPTY="-" ;;
esac
TASK_LOG="$(mktemp)"
cursor_show() { [ "$INTERACTIVE" = "1" ] && printf '\033[?25h' || true; }
trap cursor_show EXIT

task_done() { # $1 exit code, $2 label
  if [ "$1" -eq 0 ]; then
    printf "\r\033[K    ${C_GREEN}%s${C_RESET} %s\n" "$MARK_OK" "$2"
  else
    printf "\r\033[K    ${C_RED}%s${C_RESET} %s\n" "$MARK_FAIL" "$2"
    tail -n 12 "$TASK_LOG" | sed 's/^/      /'
    cursor_show
    exit 1
  fi
}

# run "label" command [args...]: shows a spinner, then a check mark or a cross with the last output lines.
run() {
  local label="$1" pid rc=0 i=0; shift
  "$@" >"$TASK_LOG" 2>&1 &
  pid=$!
  if [ "$INTERACTIVE" = "1" ]; then
    printf '\033[?25l'
    while kill -0 "$pid" 2>/dev/null; do
      printf "\r    ${C_CYAN}%s${C_RESET} %s" "${FRAMES[i % ${#FRAMES[@]}]}" "$label"
      i=$((i + 1)); sleep 0.1
    done
    printf '\033[?25h'
  fi
  wait "$pid" || rc=$?
  task_done "$rc" "$label"
}

human_size() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }

# download URL FILE label: a progress bar when the size is known, a running size otherwise.
download() {
  local url="$1" dest="$2" label="$3" total cur pid rc=0 pct filled bar width=26 n spin=0 pos
  total="$(curl -fsIL "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { v = $2 } END { print v + 0 }' || true)"
  curl -fsSL "$url" -o "$dest" >"$TASK_LOG" 2>&1 &
  pid=$!
  if [ "$INTERACTIVE" = "1" ]; then
    printf '\033[?25l'
    while kill -0 "$pid" 2>/dev/null; do
      cur="$(stat -c%s "$dest" 2>/dev/null || echo 0)"
      if [ "${total:-0}" -gt 0 ]; then
        pct=$((cur * 100 / total)); [ "$pct" -gt 100 ] && pct=100
        filled=$((pct * width / 100)); bar=""
        for ((n = 0; n < width; n++)); do if [ "$n" -lt "$filled" ]; then bar="${bar}${BAR_FULL}"; else bar="${bar}${BAR_EMPTY}"; fi; done
        printf "\r    ${C_PINK}%s${C_RESET} %3d%%  %s / %s  %s" "$bar" "$pct" "$(human_size "$cur")" "$(human_size "$total")" "$label"
      else
        pos=$((spin % (2 * (width - 6)))); [ "$pos" -ge $((width - 6)) ] && pos=$((2 * (width - 6) - pos))
        bar=""
        for ((n = 0; n < width; n++)); do if [ "$n" -ge "$pos" ] && [ "$n" -lt $((pos + 6)) ]; then bar="${bar}${BAR_FULL}"; else bar="${bar}${BAR_EMPTY}"; fi; done
        printf "\r    ${C_PINK}%s${C_RESET}  %s  %s" "$bar" "$(human_size "$cur")" "$label"
        spin=$((spin + 1))
      fi
      sleep 0.1
    done
    printf '\033[?25h'
  fi
  wait "$pid" || rc=$?
  task_done "$rc" "$label ($(human_size "$(stat -c%s "$dest" 2>/dev/null || echo 0)"))"
}

REPO="meowmarism-official/meowmarism-professional"
INSTALL_DIR="${MEOWMARISM_DIR:-/opt/meowmarism-pro}"
SERVICE_NAME="${MEOWMARISM_SERVICE:-meowmarism-pro}"
CONTROLLER_PORT="${MEOWMARISM_PORT:-}"
DEFAULT_PORT=8090
MARKER="# meowmarism-professional"
NODE_MAJOR_NEEDED=20

printf "\n${C_PINK}${C_BOLD}  meowmarism${C_RESET} ${C_BOLD}PROFESSIONAL${C_RESET}\n"
printf "\n"

[ "$(id -u)" -ne 0 ] || die "run this as a normal user with sudo rights, not as root"
command -v sudo >/dev/null 2>&1 || die "sudo is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
sudo -v || die "sudo did not accept the password"

if [ -t 0 ]; then TTY=/dev/stdin; else TTY=/dev/tty; fi
ask() { local a=""; if [ -r "$TTY" ]; then read -r a 2>/dev/null < "$TTY" || a=""; fi; printf '%s' "$a"; }

node_install_cmd() {
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_NEEDED}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR_NEEDED}.x" | sudo -E bash -
    sudo dnf install -y nodejs
  else
    die "couldn't detect apt or dnf to install Node.js. Install Node.js >=18 yourself, then re-run this script."
  fi
}

install_node() { warn "Node.js not found (or too old), installing it"; run "Installing Node.js" node_install_cmd; }

docker_install_cmd() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y docker.io
  else
    curl -fsSL https://get.docker.com | sudo sh
  fi
  sudo systemctl enable --now docker
}

install_docker() {
  warn "Docker not found"
  printf "    Install Docker now? [Y/n] "
  local a; a="$(ask)"; printf "\n"
  case "${a:0:1}" in [Nn]) die "PROFESSIONAL needs Docker. Install it and re-run this script." ;; esac
  run "Installing Docker" docker_install_cmd
}

step "Checking requirements"
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; then install_node; fi
ok "Node.js $(node -v)"
if ! command -v docker >/dev/null 2>&1; then install_docker; fi
sudo systemctl enable --now docker >/dev/null 2>&1 || true
sudo docker info >/dev/null 2>&1 || die "Docker is installed but not running. Check: sudo systemctl status docker"
ok "Docker $(sudo docker version --format '{{.Server.Version}}' 2>/dev/null)"
if ! id -nG "$(whoami)" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$(whoami)"
  info "added $(whoami) to the docker group"
fi

# MEOWMARISM_SRC points at a local checkout, for development only.
TAG="local"
if [ -z "${MEOWMARISM_SRC:-}" ]; then
  step "Finding the latest release"
  TAGS_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/tags?per_page=100")"
  TAG="$(echo "$TAGS_JSON" | grep '"name"' | sed -E 's/.*"name": *"([^"]+)".*/\1/' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
  [ -n "$TAG" ] || die "no release found yet. Check https://github.com/${REPO}/releases"
  info "latest release: $TAG"
fi
LATEST_VERSION="${TAG#v}"

port_in_use() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1$"; }
free_port_from() { local p="$1"; while port_in_use "$p"; do p=$((p + 1)); done; echo "$p"; }

# Asks for the panel port. $1 is the suggested port; an empty answer takes it.
ask_port() {
  local suggest="$1" a
  while true; do
    printf "    Port for the panel [%s]: " "$suggest"
    a="$(ask)"; printf "
"
    a="${a:-$suggest}"
    if ! printf '%s' "$a" | grep -Eq '^[0-9]{4,5}$' || [ "$a" -lt 1024 ] || [ "$a" -gt 65535 ]; then warn "Use a number between 1024 and 65535."; continue; fi
    if port_in_use "$a" && [ "$a" != "${CURRENT_PORT:-}" ]; then warn "Port $a is already in use on this host."; continue; fi
    CONTROLLER_PORT="$a"; return
  done
}

set_owner() {
  local MODE="$1" DIR="$2" ADMIN_USER="" ADMIN_PASS="" ADMIN_PASS2=""
  [ -r "$TTY" ] || die "no terminal to ask for the owner account"
  if [ "$MODE" = "reset" ]; then step "Reset the owner account"; else step "Create the owner account"; fi
  while true; do
    printf "    Username (3-32 letters, digits, . _ -): "
    read -r ADMIN_USER 2>/dev/null < "$TTY" || die "no input available"
    if printf '%s' "$ADMIN_USER" | grep -Eq '^[A-Za-z0-9_.-]{3,32}$'; then break; fi
    warn "That username isn't valid, try again."
  done
  while true; do
    printf "    Password (min. 8 characters): "
    stty -echo < "$TTY" 2>/dev/null || true
    read -r ADMIN_PASS 2>/dev/null < "$TTY" || ADMIN_PASS=""
    stty echo < "$TTY" 2>/dev/null || true
    printf "\n"
    if [ "${#ADMIN_PASS}" -lt 8 ]; then warn "Too short, try again."; continue; fi
    printf "    Repeat password: "
    stty -echo < "$TTY" 2>/dev/null || true
    read -r ADMIN_PASS2 2>/dev/null < "$TTY" || ADMIN_PASS2=""
    stty echo < "$TTY" 2>/dev/null || true
    printf "\n"
    if [ "$ADMIN_PASS" = "$ADMIN_PASS2" ]; then break; fi
    warn "The passwords don't match, try again."
  done
  printf '%s\n%s\n' "$ADMIN_USER" "$ADMIN_PASS" | node -e "
    const { users } = require('${DIR}/panel/lib/store.js');
    const fs = require('fs'), os = require('os'), path = require('path');
    const [user, pass] = fs.readFileSync(0, 'utf8').split('\n');
    users.setOwner(user, pass);
    try { fs.unlinkSync(path.join(os.homedir(), '.meowmarism-pro-sessions.json')); } catch (_) {}
  " || die "couldn't set the owner account"
  ok "Owner account is '${ADMIN_USER}'."
}

EXISTING_SERVICE=""
EXISTING_DIR=""
for f in /etc/systemd/system/*.service; do
  [ -f "$f" ] || continue
  if grep -q "^${MARKER}" "$f" 2>/dev/null; then
    EXISTING_SERVICE="$(basename "$f" .service)"
    EXISTING_DIR="$(sed -n 's/^WorkingDirectory=\(.*\)\/panel$/\1/p' "$f" | head -1)"
    CURRENT_PORT="$(sed -n 's/^Environment=CONTROLLER_PORT=\([0-9]*\)$/\1/p' "$f" | head -1)"
    break
  fi
done

if [ -n "$EXISTING_SERVICE" ]; then
  step "Found an existing install: service '${C_PINK}${EXISTING_SERVICE}${C_RESET}' at ${C_PINK}${EXISTING_DIR}${C_RESET}"
  INSTALLED_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$EXISTING_DIR/package.json" 2>/dev/null | head -1)"
  UPDATE_AVAILABLE=1
  if [ "$INSTALLED_VERSION" = "$LATEST_VERSION" ]; then UPDATE_AVAILABLE=0; info "installed v${INSTALLED_VERSION} is up to date"; else info "installed v${INSTALLED_VERSION:-unknown}, latest $TAG"; fi
  choice=""
  if [ "$UPDATE_AVAILABLE" = "1" ]; then printf "    ${C_YELLOW}[U]${C_RESET}pdate / ${C_YELLOW}[M]${C_RESET}ore options / ${C_YELLOW}[C]${C_RESET}ancel? "; else printf "    ${C_YELLOW}[M]${C_RESET}ore options / ${C_YELLOW}[C]${C_RESET}ancel? "; fi
  choice="$(ask)"
  if [ "${choice:0:1}" = "m" ] || [ "${choice:0:1}" = "M" ]; then
    printf "    ${C_YELLOW}[O]${C_RESET}wner reset / ${C_YELLOW}[P]${C_RESET}ort / ${C_YELLOW}[R]${C_RESET}emove / ${C_YELLOW}[C]${C_RESET}ancel? "
    choice="$(ask)"
  fi
  case "${choice:0:1}" in
    [Oo])
      set_owner reset "$EXISTING_DIR"
      sudo systemctl restart "$EXISTING_SERVICE"
      exit 0
      ;;
    [Rr])
      printf "\n${C_RED}${C_BOLD}  This removes the meowmarism PROFESSIONAL panel.${C_RESET}\n"
      printf "    - stops and deletes the service '%s'\n    - deletes the panel files in %s\n" "$EXISTING_SERVICE" "$EXISTING_DIR"
      printf "    Your Minecraft containers and data stay unless you choose otherwise below.\n"
      printf "\n    Type ${C_YELLOW}remove${C_RESET} to continue, anything else cancels: "
      if [ "$(ask)" != "remove" ]; then warn "Cancelled - nothing changed."; exit 0; fi
      printf "\n${C_RED}${C_BOLD}  Also delete ALL instances?${C_RESET}\n"
      printf "    This removes every meowmarism container and deletes ~/meowmarism-pro (worlds, configs) and the panel's accounts.\n"
      printf "    It cannot be undone. Type ${C_YELLOW}delete everything${C_RESET} to do it, anything else keeps your data: "
      DELETE_DATA=0; [ "$(ask)" = "delete everything" ] && DELETE_DATA=1
      step "Stopping and removing $EXISTING_SERVICE"
      sudo systemctl disable --now "$EXISTING_SERVICE" 2>/dev/null || true
      sudo rm -f "/etc/systemd/system/${EXISTING_SERVICE}.service"
      sudo systemctl daemon-reload
      sudo rm -rf "$EXISTING_DIR"
      if [ "$DELETE_DATA" = "1" ]; then
        sudo docker ps -aq --filter label=meow.managed=1 | xargs -r sudo docker rm -f >/dev/null
        sudo rm -rf "$HOME/meowmarism-pro"
        rm -f "$HOME"/.meowmarism-pro-*.json
        ok "Deleted all instances and panel data."
      else
        info "Kept your containers and data."
      fi
      ok "Uninstalled."
      exit 0
      ;;
    [Uu])
      if [ "$UPDATE_AVAILABLE" = "0" ]; then ok "Already up to date - nothing changed."; exit 0; fi
      step "Updating existing install"
      INSTALL_DIR="$EXISTING_DIR"
      SERVICE_NAME="$EXISTING_SERVICE"
      [ -n "${MEOWMARISM_PORT:-}" ] || CONTROLLER_PORT="${CURRENT_PORT:-$DEFAULT_PORT}"
      ;;
    *) warn "Cancelled - nothing changed."; exit 0 ;;
  esac
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR" "$TASK_LOG"; cursor_show' EXIT
if [ -n "${MEOWMARISM_SRC:-}" ]; then
  EXTRACTED_DIR="$MEOWMARISM_SRC"
else
  step "Downloading $TAG"
  download "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" "$TMP_DIR/release.tar.gz" "Downloading $TAG"
  run "Unpacking" tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR"
  EXTRACTED_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'meowmarism-*')"
fi

step "Installing to $INSTALL_DIR"
install_files() {
  sudo mkdir -p "$INSTALL_DIR/panel"
  sudo cp -r "$EXTRACTED_DIR/panel/." "$INSTALL_DIR/panel/"
  sudo cp "$EXTRACTED_DIR/package.json" "$INSTALL_DIR/package.json"
  sudo chown -R "$(whoami)" "$INSTALL_DIR"
}
run "Copying the panel files" install_files

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
FRESH=1; [ -f "$SERVICE_FILE" ] && FRESH=0
if [ "$FRESH" = "1" ]; then
  if [ -z "$CONTROLLER_PORT" ]; then
    step "Choose the panel port"
    if [ -r "$TTY" ]; then ask_port "$(free_port_from "$DEFAULT_PORT")"; else CONTROLLER_PORT="$(free_port_from "$DEFAULT_PORT")"; fi
  fi
  set_owner create "$INSTALL_DIR"
fi
[ -n "$CONTROLLER_PORT" ] || CONTROLLER_PORT="${CURRENT_PORT:-$DEFAULT_PORT}"

step "Writing $SERVICE_FILE"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
${MARKER}
[Unit]
Description=meowmarism PROFESSIONAL controller
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$(whoami)
SupplementaryGroups=docker
WorkingDirectory=${INSTALL_DIR}/panel
Environment=CONTROLLER_PORT=${CONTROLLER_PORT}
ExecStart=/usr/bin/env node ${INSTALL_DIR}/panel/controller.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF


wait_panel() {
  local i
  for i in $(seq 1 40); do
    if curl -fs -o /dev/null "http://127.0.0.1:${CONTROLLER_PORT}/"; then return 0; fi
    sleep 0.5
  done
  echo "the panel did not answer on port ${CONTROLLER_PORT}"
  sudo journalctl -u "$SERVICE_NAME" -n 12 --no-pager 2>/dev/null || true
  return 1
}
start_service() {
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
}
step "Starting the panel"
run "Starting the service" start_service
run "Waiting for the panel to answer" wait_panel

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$HOST_IP" ] || HOST_IP="<this-host>"
printf "\n${C_GREEN}${C_BOLD}==> Installed ${TAG} to ${INSTALL_DIR}${C_RESET}\n"
printf "${C_PINK}==>${C_RESET} Open the panel here: ${C_CYAN}http://${HOST_IP}:${CONTROLLER_PORT}/${C_RESET}\n"
printf "\n${C_DIM}  Need help? https://github.com/${REPO}/issues${C_RESET}\n\n"
