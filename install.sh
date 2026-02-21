#!/usr/bin/env bash
# =============================================================================
# Kronk Installer
# =============================================================================
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/your-org/kronk/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/your-org/kronk/main/install.sh | bash -s -- --no-init
#
# Flags:
#   --version <ver>    npm version/dist-tag (default: latest)
#   --no-init          Skip running kronk init after install
#   --dry-run          Print what would happen, no changes
#   --verbose          Debug output
#   --gum              Force gum TUI
#   --no-gum           Disable gum TUI
#   --no-prompt        Non-interactive (CI) mode
#   --help             Show usage
#
set -euo pipefail

# =============================================================================
# Constants
# =============================================================================

KRONK_VERSION="latest"
SKIP_INIT=false
DRY_RUN=false
VERBOSE=false
FORCE_GUM=""
NO_PROMPT=false

MIN_NODE_MAJOR=20
PACKAGE_NAME="kronk-ai"

# Colors (ANSI)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Taglines
TAGLINES=(
  "Pull the lever, Kronk!"
  "Oh yeah, it's all coming together."
  "Right. The poison."
  "Squirrel!"
  "By all accounts, it doesn't make sense."
  "Oh, right. The poison for Kuzco."
  "Mission: install Kronk. Let's go."
  "No touchy!"
  "Boom, baby!"
  "Feel the power."
)

# =============================================================================
# Temp file management
# =============================================================================

TEMP_DIR=""
GUM_BIN=""

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

make_temp_dir() {
  TEMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'kronk-install')"
}

# =============================================================================
# Argument parsing
# =============================================================================

usage() {
  cat <<EOF
${BOLD}Kronk Installer${RESET}

${BOLD}Usage:${RESET}
  curl -fsSL <url>/install.sh | bash
  bash install.sh [flags]

${BOLD}Flags:${RESET}
  --version <ver>    npm version or dist-tag (default: latest)
  --no-init          Skip running 'kronk init' after install
  --dry-run          Show what would happen without making changes
  --verbose          Enable debug output
  --gum              Force gum TUI enhancements
  --no-gum           Disable gum TUI
  --no-prompt        Non-interactive mode (for CI)
  --help             Show this message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      KRONK_VERSION="${2:-latest}"
      shift 2
      ;;
    --no-init)
      SKIP_INIT=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --gum)
      FORCE_GUM="yes"
      shift
      ;;
    --no-gum)
      FORCE_GUM="no"
      shift
      ;;
    --no-prompt)
      NO_PROMPT=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown flag: $1${RESET}" >&2
      usage
      exit 1
      ;;
  esac
done

# =============================================================================
# Utility functions
# =============================================================================

is_tty() {
  [[ -t 0 && -t 1 ]]
}

verbose() {
  if $VERBOSE; then
    echo -e "${DIM}[debug] $*${RESET}" >&2
  fi
}

random_tagline() {
  local idx=$((RANDOM % ${#TAGLINES[@]}))
  echo "${TAGLINES[$idx]}"
}

# =============================================================================
# Downloader detection
# =============================================================================

DOWNLOADER=""

detect_downloader() {
  if command -v curl &>/dev/null; then
    DOWNLOADER="curl"
  elif command -v wget &>/dev/null; then
    DOWNLOADER="wget"
  else
    DOWNLOADER=""
  fi
  verbose "Downloader: ${DOWNLOADER:-none}"
}

download() {
  local url="$1"
  local dest="$2"
  if [[ "$DOWNLOADER" == "curl" ]]; then
    curl -fsSL "$url" -o "$dest"
  elif [[ "$DOWNLOADER" == "wget" ]]; then
    wget -q "$url" -O "$dest"
  else
    echo -e "${RED}Error: Neither curl nor wget found. Install one and retry.${RESET}" >&2
    exit 1
  fi
}

# =============================================================================
# gum TUI bootstrap
# =============================================================================

GUM_VERSION="0.14.5"

has_gum() {
  [[ -n "$GUM_BIN" && -x "$GUM_BIN" ]]
}

bootstrap_gum() {
  if [[ "$FORCE_GUM" == "no" ]]; then
    verbose "gum disabled by --no-gum"
    return
  fi

  # Check system gum first
  if command -v gum &>/dev/null; then
    GUM_BIN="$(command -v gum)"
    verbose "Using system gum: $GUM_BIN"
    return
  fi

  if [[ "$FORCE_GUM" != "yes" ]] && ! is_tty; then
    verbose "Not a TTY, skipping gum"
    return
  fi

  if [[ -z "$DOWNLOADER" ]]; then
    verbose "No downloader available, skipping gum"
    return
  fi

  make_temp_dir

  local os arch gum_archive gum_url
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="Darwin" ;;
    Linux) os="Linux" ;;
    *)
      verbose "Unsupported OS for gum: $os"
      return
      ;;
  esac

  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      verbose "Unsupported arch for gum: $arch"
      return
      ;;
  esac

  gum_archive="gum_${GUM_VERSION}_${os}_${arch}.tar.gz"
  gum_url="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/${gum_archive}"

  verbose "Downloading gum from $gum_url"

  if download "$gum_url" "$TEMP_DIR/$gum_archive" 2>/dev/null; then
    tar -xzf "$TEMP_DIR/$gum_archive" -C "$TEMP_DIR" 2>/dev/null || true
    # gum extracts into a subdirectory
    local gum_path
    gum_path="$(find "$TEMP_DIR" -name gum -type f 2>/dev/null | head -1)"
    if [[ -n "$gum_path" && -f "$gum_path" ]]; then
      chmod +x "$gum_path"
      GUM_BIN="$gum_path"
      verbose "gum bootstrapped: $GUM_BIN"
    else
      verbose "gum binary not found after extraction"
    fi
  else
    verbose "Failed to download gum, continuing without it"
  fi
}

# =============================================================================
# UI helper functions
# =============================================================================

ui_banner() {
  local tagline
  tagline="$(random_tagline)"
  echo ""
  if has_gum; then
    "$GUM_BIN" style \
      --foreground 212 --border-foreground 212 --border double \
      --align center --width 50 --margin "1 2" --padding "1 2" \
      "KRONK" "Agentic AI Framework" "" "$tagline"
  else
    echo -e "${MAGENTA}${BOLD}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║                 KRONK                    ║"
    echo "  ║        Agentic AI Framework              ║"
    echo "  ║                                          ║"
    printf "  ║  %-40s║\n" "$tagline"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${RESET}"
  fi
}

ui_info() {
  if has_gum; then
    "$GUM_BIN" log --level info "$@"
  else
    echo -e "${BLUE}[info]${RESET} $*"
  fi
}

ui_warn() {
  if has_gum; then
    "$GUM_BIN" log --level warn "$@"
  else
    echo -e "${YELLOW}[warn]${RESET} $*" >&2
  fi
}

ui_error() {
  if has_gum; then
    "$GUM_BIN" log --level error "$@"
  else
    echo -e "${RED}[error]${RESET} $*" >&2
  fi
}

ui_success() {
  if has_gum; then
    "$GUM_BIN" log --level info "✓ $*"
  else
    echo -e "${GREEN}✓${RESET} $*"
  fi
}

ui_stage() {
  echo ""
  if has_gum; then
    "$GUM_BIN" style --foreground 212 --bold "▸ $*"
  else
    echo -e "${MAGENTA}${BOLD}▸ $*${RESET}"
  fi
}

ui_spin() {
  local title="$1"
  shift
  if has_gum && is_tty; then
    "$GUM_BIN" spin --spinner dot --title "$title" -- "$@"
  else
    ui_info "$title"
    "$@"
  fi
}

ui_dry() {
  echo -e "${CYAN}[dry-run]${RESET} $*"
}

# =============================================================================
# OS Detection
# =============================================================================

OS=""
ARCH=""
IS_WSL=false
PKG_MANAGER=""

detect_os() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  # WSL detection
  if [[ "$OS" == "Linux" ]]; then
    if grep -qi microsoft /proc/version 2>/dev/null; then
      IS_WSL=true
    fi
  fi

  case "$OS" in
    Darwin)
      verbose "Detected macOS ($ARCH)"
      ;;
    Linux)
      if $IS_WSL; then
        verbose "Detected Linux (WSL) ($ARCH)"
      else
        verbose "Detected Linux ($ARCH)"
      fi
      # Detect package manager
      if command -v apt-get &>/dev/null; then
        PKG_MANAGER="apt"
      elif command -v dnf &>/dev/null; then
        PKG_MANAGER="dnf"
      elif command -v yum &>/dev/null; then
        PKG_MANAGER="yum"
      elif command -v apk &>/dev/null; then
        PKG_MANAGER="apk"
      fi
      verbose "Package manager: ${PKG_MANAGER:-unknown}"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      ui_error "Windows is not directly supported."
      ui_info "Please use WSL (Windows Subsystem for Linux):"
      ui_info "  1. Install WSL: wsl --install"
      ui_info "  2. Open a WSL terminal"
      ui_info "  3. Re-run this installer"
      exit 1
      ;;
    *)
      ui_error "Unsupported operating system: $OS"
      exit 1
      ;;
  esac
}

# =============================================================================
# Homebrew (macOS)
# =============================================================================

ensure_homebrew() {
  if [[ "$OS" != "Darwin" ]]; then
    return
  fi

  if command -v brew &>/dev/null; then
    verbose "Homebrew already installed"
    return
  fi

  ui_stage "Installing Homebrew"

  if $DRY_RUN; then
    ui_dry "Would install Homebrew"
    return
  fi

  ui_spin "Installing Homebrew..." bash -c \
    'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'

  # Add brew to PATH for current session
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi

  if command -v brew &>/dev/null; then
    ui_success "Homebrew installed"
  else
    ui_warn "Homebrew installation may have failed. Continuing anyway..."
  fi
}

# =============================================================================
# Node.js
# =============================================================================

check_node_version() {
  if ! command -v node &>/dev/null; then
    return 1
  fi

  local node_version
  node_version="$(node --version 2>/dev/null | sed 's/^v//')"
  local major
  major="$(echo "$node_version" | cut -d. -f1)"

  verbose "Node.js version: $node_version (major: $major, required: >= $MIN_NODE_MAJOR)"

  if [[ "$major" -ge "$MIN_NODE_MAJOR" ]]; then
    return 0
  else
    return 1
  fi
}

install_node() {
  ui_stage "Installing Node.js"

  if check_node_version; then
    local ver
    ver="$(node --version)"
    ui_success "Node.js $ver already installed"
    return
  fi

  if command -v node &>/dev/null; then
    local ver
    ver="$(node --version)"
    ui_warn "Node.js $ver is installed but version $MIN_NODE_MAJOR+ is required"
  fi

  if $DRY_RUN; then
    ui_dry "Would install Node.js >= $MIN_NODE_MAJOR"
    return
  fi

  case "$OS" in
    Darwin)
      ensure_homebrew
      ui_spin "Installing Node.js via Homebrew..." brew install node
      ;;
    Linux)
      case "$PKG_MANAGER" in
        apt)
          ui_info "Installing Node.js via NodeSource (apt)..."
          curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
          sudo apt-get install -y nodejs
          ;;
        dnf)
          ui_info "Installing Node.js via NodeSource (dnf)..."
          curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo bash -
          sudo dnf install -y nodejs
          ;;
        yum)
          ui_info "Installing Node.js via NodeSource (yum)..."
          curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo bash -
          sudo yum install -y nodejs
          ;;
        apk)
          sudo apk add --no-cache nodejs npm
          ;;
        *)
          ui_error "Could not auto-install Node.js. Please install Node.js >= $MIN_NODE_MAJOR manually."
          ui_info "Visit: https://nodejs.org/en/download/"
          exit 1
          ;;
      esac
      ;;
  esac

  # Verify
  if check_node_version; then
    local ver
    ver="$(node --version)"
    ui_success "Node.js $ver installed"
  else
    ui_error "Node.js installation failed or version too old."
    exit 1
  fi
}

# =============================================================================
# npm permissions fix (Linux)
# =============================================================================

fix_npm_permissions() {
  if [[ "$OS" != "Linux" ]]; then
    return
  fi

  # Skip if running as root
  if [[ "$(id -u)" -eq 0 ]]; then
    return
  fi

  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "/usr/local")"

  # If prefix is a system dir, set up user-local prefix
  if [[ "$npm_prefix" == "/usr" || "$npm_prefix" == "/usr/local" ]]; then
    ui_info "Configuring npm for user-local installs..."

    if $DRY_RUN; then
      ui_dry "Would set npm prefix to ~/.npm-global"
      return
    fi

    local npm_global="$HOME/.npm-global"
    mkdir -p "$npm_global"
    npm config set prefix "$npm_global"

    # Add to PATH if not already there
    if [[ ":$PATH:" != *":$npm_global/bin:"* ]]; then
      export PATH="$npm_global/bin:$PATH"

      # Persist to shell profile
      local profile=""
      if [[ -f "$HOME/.bashrc" ]]; then
        profile="$HOME/.bashrc"
      elif [[ -f "$HOME/.zshrc" ]]; then
        profile="$HOME/.zshrc"
      elif [[ -f "$HOME/.profile" ]]; then
        profile="$HOME/.profile"
      fi

      if [[ -n "$profile" ]]; then
        local line='export PATH="$HOME/.npm-global/bin:$PATH"'
        if ! grep -qF ".npm-global/bin" "$profile" 2>/dev/null; then
          echo "" >> "$profile"
          echo "# npm global packages" >> "$profile"
          echo "$line" >> "$profile"
          ui_info "Added npm-global to PATH in $profile"
        fi
      fi
    fi

    ui_success "npm configured for user-local installs"
  fi
}

# =============================================================================
# Install kronk
# =============================================================================

install_kronk() {
  ui_stage "Installing Kronk"

  local pkg_spec="$PACKAGE_NAME"
  if [[ "$KRONK_VERSION" != "latest" ]]; then
    pkg_spec="${PACKAGE_NAME}@${KRONK_VERSION}"
  fi

  # Check for existing install
  if command -v kronk &>/dev/null; then
    local current
    current="$(kronk --version 2>/dev/null || echo "unknown")"
    ui_info "Existing Kronk installation found (v$current)"
    if [[ "$KRONK_VERSION" == "latest" ]]; then
      ui_info "Upgrading to latest version..."
    else
      ui_info "Installing version $KRONK_VERSION..."
    fi
  fi

  if $DRY_RUN; then
    ui_dry "Would run: npm install -g $pkg_spec"
    return
  fi

  local max_retries=3
  local attempt=0

  while [[ $attempt -lt $max_retries ]]; do
    attempt=$((attempt + 1))
    verbose "Install attempt $attempt of $max_retries"

    if ui_spin "Installing $pkg_spec..." npm install -g "$pkg_spec" 2>&1; then
      break
    fi

    local exit_code=$?

    if [[ $attempt -lt $max_retries ]]; then
      # Handle EEXIST by cleaning stale directories
      if npm install -g "$pkg_spec" 2>&1 | grep -q "EEXIST"; then
        ui_warn "Stale directory detected, cleaning up..."
        local npm_prefix
        npm_prefix="$(npm config get prefix)"
        local stale_dir="$npm_prefix/lib/node_modules/$PACKAGE_NAME"
        if [[ -d "$stale_dir" ]]; then
          rm -rf "$stale_dir"
          verbose "Cleaned $stale_dir"
        fi
      fi

      local wait_time=$((attempt * 3))
      ui_warn "Install failed (attempt $attempt/$max_retries). Retrying in ${wait_time}s..."
      sleep "$wait_time"
    else
      ui_error "Installation failed after $max_retries attempts."
      ui_info "Try manually: npm install -g $pkg_spec"
      exit 1
    fi
  done

  ui_success "Kronk installed"
}

# =============================================================================
# Resolve kronk binary
# =============================================================================

resolve_kronk_bin() {
  local bin_path=""

  if command -v kronk &>/dev/null; then
    bin_path="$(command -v kronk)"
    verbose "kronk binary at: $bin_path"
    echo "$bin_path"
    return
  fi

  # Check common locations
  local candidates=(
    "$HOME/.npm-global/bin/kronk"
    "/usr/local/bin/kronk"
    "/usr/bin/kronk"
  )

  # Homebrew paths
  if [[ "$OS" == "Darwin" ]]; then
    candidates+=(
      "/opt/homebrew/bin/kronk"
      "/usr/local/Cellar/node/*/bin/kronk"
    )
  fi

  for candidate in "${candidates[@]}"; do
    # Expand globs
    for expanded in $candidate; do
      if [[ -x "$expanded" ]]; then
        verbose "Found kronk at: $expanded"
        echo "$expanded"
        return
      fi
    done
  done

  ui_error "Could not find kronk binary on PATH."
  ui_info "You may need to restart your shell or add npm global bin to PATH."
  exit 1
}

# =============================================================================
# Auto-run kronk init
# =============================================================================

run_kronk_init() {
  if $SKIP_INIT; then
    verbose "Skipping kronk init (--no-init)"
    return
  fi

  if $NO_PROMPT; then
    verbose "Skipping kronk init (--no-prompt / non-interactive)"
    return
  fi

  if ! is_tty; then
    ui_info "Non-interactive environment detected. Skipping kronk init."
    ui_info "Run 'kronk init' to set up your agent."
    return
  fi

  local kronk_bin
  kronk_bin="$(resolve_kronk_bin)"

  echo ""
  ui_stage "Setting up your Kronk agent"
  echo ""

  if $DRY_RUN; then
    ui_dry "Would run: $kronk_bin init"
    return
  fi

  exec "$kronk_bin" init
}

# =============================================================================
# Completion banner
# =============================================================================

completion_banner() {
  echo ""
  if has_gum; then
    "$GUM_BIN" style \
      --foreground 212 --border-foreground 82 --border rounded \
      --align center --width 50 --margin "1 2" --padding "1 2" \
      "Kronk is installed!" "" \
      "Run 'kronk init' to get started" \
      "Run 'kronk --help' for all commands"
  else
    echo -e "${GREEN}${BOLD}"
    echo "  ┌──────────────────────────────────────────┐"
    echo "  │         Kronk is installed!               │"
    echo "  │                                           │"
    echo "  │  Run 'kronk init' to get started          │"
    echo "  │  Run 'kronk --help' for all commands      │"
    echo "  └──────────────────────────────────────────┘"
    echo -e "${RESET}"
  fi
}

# =============================================================================
# Main
# =============================================================================

main() {
  detect_downloader
  bootstrap_gum
  ui_banner

  if $DRY_RUN; then
    ui_info "Dry run mode — no changes will be made"
    echo ""
  fi

  detect_os

  if [[ "$OS" == "Darwin" ]]; then
    ensure_homebrew
  fi

  install_node

  if [[ "$OS" == "Linux" ]]; then
    fix_npm_permissions
  fi

  install_kronk

  if $SKIP_INIT || $NO_PROMPT; then
    completion_banner
  else
    run_kronk_init
    # If exec didn't replace us (dry-run), show banner
    completion_banner
  fi
}

main
