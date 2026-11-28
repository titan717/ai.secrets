#!/bin/sh
# Install the secrets-ai CLI + bridge for the current user on Linux or macOS. No sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/titan717/ai.secrets/main/scripts/install.sh | sh
#   # or, after reading it:  sh scripts/install.sh
#
# Environment knobs:
#   SECRETS_AI_REPO      git URL       (default https://github.com/titan717/ai.secrets.git)
#   SECRETS_AI_REF       branch/tag    (default main)
#   SECRETS_AI_DIR       checkout dir  (default ~/.local/share/ai.secrets)
#   SECRETS_AI_BIN_DIR   shim dir      (default ~/.local/bin)
#   OPENCODE_VERSION     opencode-ai   (default 1.19.6; set to "skip" to not install it)
#   SECRETS_AI_SYSTEMD=1 also install + start the systemd user unit (Linux)
#
# Idempotent: re-running updates the checkout and rebuilds.
set -eu

REPO="${SECRETS_AI_REPO:-https://github.com/titan717/ai.secrets.git}"
REF="${SECRETS_AI_REF:-main}"
DIR="${SECRETS_AI_DIR:-$HOME/.local/share/ai.secrets}"
BIN_DIR="${SECRETS_AI_BIN_DIR:-$HOME/.local/bin}"
OPENCODE_VERSION="${OPENCODE_VERSION:-1.19.6}"
PNPM_VERSION="9.15.9"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have node || die "Node.js 20+ is required (https://nodejs.org, or your package manager / nvm)."
have npm || die "npm is required (it ships with Node.js)."
have git || die "git is required."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ is required (found $(node -v))."
NODE_BIN=$(node -p 'process.execPath')

mkdir -p "$BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) PATH="$BIN_DIR:$PATH"; export PATH; ADD_PATH=1 ;;
esac

# 1. OpenCode (user prefix so no sudo is needed).
if [ "$OPENCODE_VERSION" = "skip" ]; then
  say "skipping opencode install (OPENCODE_VERSION=skip)"
elif have opencode && [ "$(opencode --version 2>/dev/null || true)" = "$OPENCODE_VERSION" ]; then
  say "opencode $OPENCODE_VERSION already installed"
else
  say "installing opencode-ai@$OPENCODE_VERSION into $(dirname "$BIN_DIR")"
  npm install -g --prefix "$(dirname "$BIN_DIR")" --no-audit --no-fund "opencode-ai@$OPENCODE_VERSION"
  opencode --version >/dev/null 2>&1 || die "opencode did not install correctly; see https://opencode.ai/docs"
fi

# 2. Source checkout.
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

# 3. Build with the pinned pnpm (via npm exec, nothing global).
say "installing dependencies and building"
cd "$DIR"
if have pnpm; then PNPM="pnpm"; else PNPM="npm exec --yes pnpm@$PNPM_VERSION --"; fi
$PNPM install --frozen-lockfile
$PNPM build

# 4. Shim with an absolute node path (works from systemd/launchd without a login PATH).
SHIM="$BIN_DIR/secrets-ai"
cat > "$SHIM" <<SHIM_EOF
#!/bin/sh
exec "$NODE_BIN" "$DIR/dist/cli/index.js" "\$@"
SHIM_EOF
chmod 755 "$SHIM"
say "installed $SHIM"

# 5. Config dir + token (no prompts: stdin may be this script when piped from curl).
"$SHIM" init </dev/null

# 6. Optional systemd user unit.
if [ "${SECRETS_AI_SYSTEMD:-0}" = "1" ]; then
  if have systemctl; then
    mkdir -p "$HOME/.config/systemd/user" "$HOME/secrets-workspace"
    cp "$DIR/deploy/secrets-ai.user.service" "$HOME/.config/systemd/user/secrets-ai.service"
    systemctl --user daemon-reload
    systemctl --user enable --now secrets-ai
    say "systemd user service started (journalctl --user -u secrets-ai -f)"
  else
    say "systemctl not found; skipping the user service (macOS: see docs/RUN-MODES.md for launchd)"
  fi
fi

if [ "${ADD_PATH:-0}" = "1" ]; then
  # shellcheck disable=SC2016 # literal $PATH on purpose
  printf '\nAdd %s to your PATH, e.g.:\n  echo '\''export PATH="%s:$PATH"'\'' >> ~/.profile\n' "$BIN_DIR" "$BIN_DIR"
fi
printf '\nDone. Store a key with: secrets-ai auth set openrouter\n'
