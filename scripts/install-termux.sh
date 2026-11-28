#!/data/data/com.termux/files/usr/bin/sh
# Install secrets-ai on Android via Termux. POSIX sh, idempotent, no sudo/root.
#
#   curl -fsSL https://raw.githubusercontent.com/titan717/ai.secrets/main/scripts/install-termux.sh | sh
#
# OpenCode 1.19.6 publishes NO Android build: `opencode-ai` lists os darwin/linux/win32 only, and
# its linux-arm64 binaries are linked against glibc (/lib/ld-linux-aarch64.so.1) or musl, neither
# of which Termux (Bionic libc) provides. This script therefore:
#   1. tries `npm i -g opencode-ai` in case a future release supports Android;
#   2. otherwise (default OPENCODE_MODE=auto) installs Termux's glibc-runner and wraps the official
#      opencode-linux-arm64 binary with `grun` (experimental);
#   3. if that fails too, prints the fallbacks: proot-distro, or a remote bridge (client-only).
#
# Knobs: SECRETS_AI_REPO, SECRETS_AI_REF (main), SECRETS_AI_DIR (~/.local/share/ai.secrets),
#        OPENCODE_VERSION (1.19.6), OPENCODE_MODE=auto|npm|grun|skip
set -eu

REPO="${SECRETS_AI_REPO:-https://github.com/titan717/ai.secrets.git}"
REF="${SECRETS_AI_REF:-main}"
DIR="${SECRETS_AI_DIR:-$HOME/.local/share/ai.secrets}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.19.6}"
OPENCODE_MODE="${OPENCODE_MODE:-auto}"
PNPM_VERSION="9.15.9"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "${PREFIX:-}" in
  *com.termux*) ;;
  *) die "this script is for Termux (PREFIX does not contain com.termux). Use scripts/install.sh elsewhere." ;;
esac
BIN_DIR="$PREFIX/bin"

# 1. Packages (only what is missing).
NEED=""
have node || NEED="$NEED nodejs-lts"
have git || NEED="$NEED git"
if [ -n "$NEED" ]; then
  say "pkg install$NEED"
  pkg update -y
  # shellcheck disable=SC2086
  pkg install -y $NEED
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node -v)); run: pkg install nodejs-lts"

opencode_ok() { have opencode && opencode --version >/dev/null 2>&1; }

install_opencode_npm() {
  say "trying npm i -g opencode-ai@$OPENCODE_VERSION"
  npm install -g --no-audit --no-fund "opencode-ai@$OPENCODE_VERSION" >/dev/null 2>&1 && opencode_ok
}

install_opencode_grun() {
  say "installing glibc-runner and wrapping opencode-linux-arm64@$OPENCODE_VERSION (experimental)"
  [ "$(uname -m)" = "aarch64" ] || { warn "glibc wrapper needs aarch64 (found $(uname -m))"; return 1; }
  have grun || { pkg install -y glibc-repo && pkg install -y glibc-runner; } || return 1
  OC_DIR="$PREFIX/opt/opencode-$OPENCODE_VERSION"
  if [ ! -x "$OC_DIR/bin/opencode" ]; then
    TMP=$(mktemp -d)
    (cd "$TMP" && npm pack --silent "opencode-linux-arm64@$OPENCODE_VERSION" >/dev/null && tar xzf ./*.tgz) || { rm -rf "$TMP"; return 1; }
    mkdir -p "$OC_DIR"
    cp -R "$TMP/package/." "$OC_DIR/"
    rm -rf "$TMP"
    chmod 755 "$OC_DIR/bin/opencode"
  fi
  cat > "$BIN_DIR/opencode" <<WRAP_EOF
#!/data/data/com.termux/files/usr/bin/sh
exec grun "$OC_DIR/bin/opencode" "\$@"
WRAP_EOF
  chmod 755 "$BIN_DIR/opencode"
  opencode_ok
}

# 2. OpenCode.
if opencode_ok; then
  say "opencode $(opencode --version 2>/dev/null) already works"
else
  case "$OPENCODE_MODE" in
    skip) say "skipping opencode (OPENCODE_MODE=skip): use this phone as a client of a remote bridge" ;;
    npm) install_opencode_npm || warn "npm install of opencode-ai failed (no Android build)" ;;
    grun) install_opencode_grun || warn "glibc-runner wrapper failed" ;;
    *) install_opencode_npm || install_opencode_grun || warn "could not get a working opencode on this device" ;;
  esac
fi
if ! opencode_ok && [ "$OPENCODE_MODE" != "skip" ]; then
  cat >&2 <<'MSG'

OpenCode is not available natively on Android. Fallbacks:
  A) Run everything in a Debian userland (most reliable):
       pkg install proot-distro && proot-distro install debian && proot-distro login debian
       # inside: apt update && apt install -y curl git nodejs npm, then run scripts/install.sh
  B) Use this phone as a client only: run the bridge on a PC/VPS and connect through an SSH tunnel:
       ssh -N -L 8790:127.0.0.1:8790 user@your-vps &
       export SECRETS_AI_URL=http://127.0.0.1:8790 SECRETS_AI_TOKEN=<token from the server>
       secrets-ai chat
The secrets-ai CLI is still installed below.
MSG
fi

# 3. secrets-ai from git.
if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" checkout --quiet "$REF"
  git -C "$DIR" pull --quiet --ff-only origin "$REF" || true
else
  say "cloning $REPO into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$REF" "$REPO" "$DIR"
fi
cd "$DIR"
if have pnpm; then PNPM="pnpm"; else PNPM="npm exec --yes pnpm@$PNPM_VERSION --"; fi
say "installing dependencies and building"
$PNPM install --frozen-lockfile
$PNPM build

cat > "$BIN_DIR/secrets-ai" <<SHIM_EOF
#!/data/data/com.termux/files/usr/bin/sh
exec node "$DIR/dist/cli/index.js" "\$@"
SHIM_EOF
chmod 755 "$BIN_DIR/secrets-ai"
say "installed $BIN_DIR/secrets-ai"

# 4. Config dir + token (no prompts; stdin may be this script).
secrets-ai init </dev/null

# shellcheck disable=SC2016 # literal text on purpose
printf '\nNext: secrets-ai auth set openrouter && secrets-ai serve   (then `secrets-ai chat` in a new session)\n'
printf 'Tip: termux-wake-lock keeps the bridge alive while the screen is off.\n'
