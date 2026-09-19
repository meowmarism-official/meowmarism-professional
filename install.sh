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

REPO="meowmarism-official/meowmarism-professional"
INSTALL_DIR="${MEOWMARISM_DIR:-/opt/meowmarism-pro}"
SERVICE_NAME="${MEOWMARISM_SERVICE:-meowmarism-pro}"
CONTROLLER_PORT="${MEOWMARISM_PORT:-8090}"
MARKER="# meowmarism-professional"
NODE_MAJOR_NEEDED=20

printf "\n${C_PINK}${C_BOLD}  meowmarism${C_RESET} ${C_BOLD}PROFESSIONAL${C_RESET}\n"
printf "${C_DIM}  Minecraft servers in Docker containers with hard resource limits${C_RESET}\n\n"

[ "$(id -u)" -ne 0 ] || die "run this as a normal user with sudo rights, not as root"
command -v sudo >/dev/null 2>&1 || die "sudo is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

if [ -t 0 ]; then TTY=/dev/stdin; else TTY=/dev/tty; fi
ask() { local a=""; if [ -r "$TTY" ]; then read -r a 2>/dev/null < "$TTY" || a=""; fi; printf '%s' "$a"; }

install_node() {
  warn "Node.js not found (or too old), installing it"
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

install_docker() {
  warn "Docker not found"
  printf "    Install Docker now? [Y/n] "
  local a; a="$(ask)"; printf "\n"
  case "${a:0:1}" in [Nn]) die "PROFESSIONAL needs Docker. Install it and re-run this script." ;; esac
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y docker.io
  else
    curl -fsSL https://get.docker.com | sudo sh
  fi
  sudo systemctl enable --now docker
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
    printf "    ${C_YELLOW}[O]${C_RESET}wner reset / ${C_YELLOW}[R]${C_RESET}emove / ${C_YELLOW}[C]${C_RESET}ancel? "
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
      ;;
    *) warn "Cancelled - nothing changed."; exit 0 ;;
  esac
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
if [ -n "${MEOWMARISM_SRC:-}" ]; then
  EXTRACTED_DIR="$MEOWMARISM_SRC"
else
  step "Downloading $TAG"
  curl -fL --progress-bar "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" -o "$TMP_DIR/release.tar.gz"
  tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR"
  EXTRACTED_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'meowmarism-*')"
fi

step "Installing to $INSTALL_DIR"
sudo mkdir -p "$INSTALL_DIR/panel"
sudo cp -r "$EXTRACTED_DIR/panel/." "$INSTALL_DIR/panel/"
sudo cp "$EXTRACTED_DIR/package.json" "$INSTALL_DIR/package.json"
sudo chown -R "$(whoami)" "$INSTALL_DIR"

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
FRESH=1; [ -f "$SERVICE_FILE" ] && FRESH=0
if [ "$FRESH" = "1" ]; then set_owner create "$INSTALL_DIR"; fi

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

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
sudo systemctl restart "$SERVICE_NAME"

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "$HOST_IP" ] || HOST_IP="<this-host>"
printf "\n${C_GREEN}${C_BOLD}==> Installed ${TAG} to ${INSTALL_DIR}${C_RESET}\n"
printf "${C_PINK}==>${C_RESET} Open the panel here: ${C_CYAN}http://${HOST_IP}:${CONTROLLER_PORT}/${C_RESET}\n"
printf "\n${C_DIM}  Need help? https://github.com/${REPO}/issues${C_RESET}\n\n"
