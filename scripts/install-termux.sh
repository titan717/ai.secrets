#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${SECRETS_AI_REPO:-https://github.com/titan717/ai.secrets.git}"
INSTALL_DIR="${SECRETS_AI_DIR:-$HOME/ai.secrets}"

if ! command -v pkg >/dev/null 2>&1; then
  echo "Warning: 'pkg' not found. This script is intended for Termux on Android." >&2
fi

if ! command -v node >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "Installing nodejs-lts and git..."
  pkg update -y
  pkg install -y nodejs-lts git
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm..."
  npm install -g pnpm
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating ai.secrets in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Cloning ai.secrets into $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
pnpm install
pnpm build

# Link secrets-ai CLI globally into Termux PATH
if [ -f "$INSTALL_DIR/dist/cli/index.js" ]; then
  chmod +x "$INSTALL_DIR/dist/cli/index.js"
fi
pnpm link --global || {
  BIN_DIR="${PREFIX:-$HOME/.local}/bin"
  mkdir -p "$BIN_DIR"
  ln -sf "$INSTALL_DIR/dist/cli/index.js" "$BIN_DIR/secrets-ai"
}

echo "Running initial secrets-ai setup..."
if command -v secrets-ai >/dev/null 2>&1; then
  secrets-ai init
else
  node "$INSTALL_DIR/dist/cli/index.js" init
fi

echo "Done! Start the bridge with: secrets-ai serve"
