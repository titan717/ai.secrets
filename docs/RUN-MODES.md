# Run modes

`secrets-ai` is both the bridge launcher (`secrets-ai serve`) and its terminal client (`chat`, `run`, `models`, `settings`, `doctor`). The bridge supervises the real OpenCode CLI (`opencode serve`, pinned to 1.19.6) and exposes the HTTP+SSE API in `src/core/api.ts`.

Rules for every mode:

- The bridge binds to **127.0.0.1** by default. Keep it that way, and reach it remotely through an SSH tunnel or a TLS reverse proxy.
- Every `/v1/*` route requires `Authorization: Bearer <token>`. The token is generated on first run into `~/.config/secrets-ai/auth.json` (mode 0600; `%APPDATA%\secrets-ai\auth.json` on Windows). Override it with `SECRETS_AI_TOKEN`.
- API keys are never accepted as command-line arguments. Use `secrets-ai auth set <openrouter|google|github|secrets>` (hidden prompt), pipe them in (`... | secrets-ai auth set openrouter --key-stdin`), or set them in the environment (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `SECRETS_TOKEN`).
- `secrets-ai doctor` checks the bridge, the token, the `opencode` binary and its version, the Node version, the platform (including Termux) and config-dir permissions.

| Mode | Start | Where the token lives |
| --- | --- | --- |
| Terminal | `secrets-ai serve`, plus `secrets-ai chat` in another terminal, or `secrets-ai chat --local` | `~/.config/secrets-ai/auth.json` |
| Local daemon | systemd user unit / launchd | same |
| VPS | systemd system unit + SSH tunnel or TLS proxy | `/var/lib/secrets-ai/auth.json` |
| Docker | `docker compose -f deploy/docker-compose.yml up -d` | `secrets-ai-config` volume |
| Termux | `scripts/install-termux.sh` | `~/.config/secrets-ai` in Termux |
| Windows | PowerShell, see below | `%APPDATA%\secrets-ai` |

## Terminal

```sh
sh scripts/install.sh              # or: pnpm install && pnpm build && alias secrets-ai="node $PWD/dist/cli/index.js"
secrets-ai init --provider openrouter   # creates the token, asks for the key (hidden)
secrets-ai serve                   # terminal 1: bridge on http://127.0.0.1:8790
secrets-ai chat                    # terminal 2
```

Without a second terminal, `--local` starts a private bridge in-process (random port) for the duration of the command:

```sh
secrets-ai chat --local --workspace ~/code/project
secrets-ai run --local "summarize README.md"
```

### chat

Text streams live. Reasoning is hidden unless you pass `--show-reasoning` (it is shown dimmed). Each tool call gets a one-line summary, and each turn ends with a token/cost line.

- Permission requests prompt `[a]llow once / [s]ession / [d]eny`. Pressing EOF denies.
- Questions show numbered options. Type a number (or `1,3` when multiple answers are allowed) or free text. An empty answer dismisses the question.
- Ctrl+C during a turn aborts it, and a second Ctrl+C exits.
- Slash commands: `/model [id]`, `/effort [low|medium|high|custom:<steps>[:<variant>]]`, `/new`, `/sessions [id]`, `/abort`, `/usage`, `/help`, `/exit`.

### run (scripting)

```sh
secrets-ai run "fix the failing test" --yes            # allow tool permissions automatically
secrets-ai run "list TODOs" --json | jq -r 'select(.type=="text.delta").text'
echo "long prompt" | secrets-ai run -                  # prompt from stdin
```

- Text goes to stdout. Tool, permission and usage lines go to stderr. `--json` prints every `AiEvent` as NDJSON on stdout.
- Permissions: on a TTY you are prompted. **When stdin is not a TTY, permissions are denied unless you pass `--yes`.** `--deny-all` always denies. Questions are dismissed when there is no TTY.
- Exit codes: `0` ok, `1` turn or API error, `2` usage error, `3` bridge unreachable, `130` interrupted.

### Client configuration

| Flag | Env | Default |
| --- | --- | --- |
| `--url` | `SECRETS_AI_URL` | `http://127.0.0.1:8790` |
| `--token` | `SECRETS_AI_TOKEN` | token in the auth file |
| `--no-color` | `NO_COLOR` | colors only on a TTY |

`secrets-ai settings set provider=google model=gemini-2.5-flash effort=custom:12:high agentMode=plan tools.github=true` updates the running bridge, or writes `settings.json` directly when the bridge is down.

## Local daemon

### Linux (systemd user unit)

```sh
SECRETS_AI_SYSTEMD=1 sh scripts/install.sh
# or manually:
mkdir -p ~/.config/systemd/user ~/secrets-workspace
cp deploy/secrets-ai.user.service ~/.config/systemd/user/secrets-ai.service
systemctl --user daemon-reload && systemctl --user enable --now secrets-ai
loginctl enable-linger "$USER"      # keep it running after logout
journalctl --user -u secrets-ai -f
```

The unit runs `~/.local/bin/secrets-ai serve` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and write access only to `~/.config/secrets-ai`, `~/secrets-workspace` and `~/.cache`. To point it at another project, run `systemctl --user edit secrets-ai` and add `Environment=SECRETS_AI_WORKSPACE=...` plus a matching `ReadWritePaths=...`. Some of these options need unprivileged user namespaces. If the unit fails with status 218 or 226, comment them out.

### macOS (launchd)

macOS has no systemd. Save the following as `~/Library/LaunchAgents/ai.secrets.bridge.plist`, then run `launchctl load -w ~/Library/LaunchAgents/ai.secrets.bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.secrets.bridge</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/.local/bin/secrets-ai</string><string>serve</string>
    <string>--workspace</string><string>/Users/YOU/secrets-workspace</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/Users/YOU/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/secrets-ai.log</string>
  <key>StandardOutPath</key><string>/Users/YOU/Library/Logs/secrets-ai.log</string>
</dict></plist>
```

## VPS

1. Install the system unit by following the header of `deploy/secrets-ai.service`. You create a `secrets-ai` system user, put the checkout in `/opt/ai.secrets`, keep state in `/var/lib/secrets-ai` (0700) and the workspace in `/srv/secrets-ai/workspace`, and write keys to `/etc/secrets-ai/secrets-ai.env` (mode 0600, template: `deploy/secrets-ai.env.example`).
2. Keep `HOST=127.0.0.1`. The unit adds `NoNewPrivileges`, `ProtectSystem=strict` (with `ReadWritePaths` limited to state and workspace), `ProtectHome`, `PrivateTmp`, `PrivateDevices`, an empty capability set and `Restart=on-failure`. OpenCode's shell and edit tools run inside these limits.
3. Print the token on the server: `sudo -u secrets-ai SECRETS_AI_HOME=/var/lib/secrets-ai node /opt/ai.secrets/dist/cli/index.js auth token --show`.
4. Connect from your machine using one of these:
   - **SSH tunnel (simplest, no public port):** `ssh -N -L 8790:127.0.0.1:8790 you@vps`, then `SECRETS_AI_TOKEN=... secrets-ai chat` locally.
   - **TLS reverse proxy**, for example Caddy on the VPS. The bridge stays on 127.0.0.1, and only 443 is public:
     ```
     ai.example.com {
       reverse_proxy 127.0.0.1:8790 {
         flush_interval -1        # do not buffer SSE
       }
     }
     ```
     With nginx, set `proxy_buffering off; proxy_read_timeout 1h; proxy_http_version 1.1;`. Then use `secrets-ai --url https://ai.example.com chat`. The bearer token is still required. Never expose plain HTTP.

## Docker

```sh
cp deploy/secrets-ai.env.example deploy/secrets-ai.env && chmod 600 deploy/secrets-ai.env   # optional
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec secrets-ai secrets-ai auth set openrouter
docker compose -f deploy/docker-compose.yml exec secrets-ai secrets-ai auth token     # compose exec allocates a TTY; add --show when piping
```

- The image is a multi-stage `node:20-slim` build. The runtime stage has `opencode-ai@1.19.6` (build arg `OPENCODE_VERSION`), git, ripgrep and tini. It runs as the non-root `node` user, with a `HEALTHCHECK` on `/health`.
- Inside the container `HOST=0.0.0.0` is required for port publishing. **Publish to loopback only** (`127.0.0.1:8790:8790`, as in the compose file) or put a TLS reverse proxy in front. The bearer token is still required.
- Volumes: `/home/node/.config/secrets-ai` holds the token, settings and OpenCode state. `/workspace` holds the files the agent works on (compose mounts `${SECRETS_AI_WORKSPACE_DIR:-./workspace}`).
- Plain docker: `docker run -d -p 127.0.0.1:8790:8790 -v secrets-ai-config:/home/node/.config/secrets-ai -v "$PWD:/workspace" secrets-ai`.

## Termux (Android)

```sh
curl -fsSL https://raw.githubusercontent.com/titan717/ai.secrets/main/scripts/install-termux.sh | sh
secrets-ai auth set openrouter
termux-wake-lock; secrets-ai serve      # session 1
secrets-ai chat                         # session 2 (swipe from the left edge, "New session")
```

**OpenCode support on Android.** This was checked with `npm view opencode-ai@1.19.6` on 2026-11-28. `opencode-ai` declares `os: [darwin, linux, win32]` and publishes no Android package. Its `opencode-linux-arm64` / `-musl` binaries request `/lib/ld-linux-aarch64.so.1` / `/lib/ld-musl-aarch64.so.1`, and Termux's Bionic libc provides neither. As a result, `npm i -g opencode-ai` does not give a working binary on Termux. The installer tries, in order:

1. `npm i -g opencode-ai`, in case a future release adds Android.
2. `OPENCODE_MODE=grun` (the default fallback): it installs Termux's `glibc-repo` + `glibc-runner` and wraps the official linux-arm64 binary as `$PREFIX/bin/opencode`, which runs `grun .../opencode`. **Experimental and unverified on a device.**
3. If both fail, it prints two alternatives:
   - **proot-distro**: `pkg install proot-distro && proot-distro install debian && proot-distro login debian`, then `scripts/install.sh` inside Debian. This is the most reliable option.
   - **Client only**: run the bridge on a PC or VPS and connect the phone over an SSH tunnel (`pkg install openssh`, `ssh -N -L 8790:127.0.0.1:8790 you@vps`). Use `OPENCODE_MODE=skip` to install just the CLI.

`secrets-ai doctor` reports `termux (android arm64)` when `$PREFIX` contains `com.termux`.

## Windows (PowerShell)

```powershell
winget install OpenJS.NodeJS.LTS Git.Git        # Node 20+, git
npm install -g opencode-ai@1.19.6
npm install -g pnpm@9.15.9
git clone https://github.com/titan717/ai.secrets "$env:LOCALAPPDATA\ai.secrets"
cd "$env:LOCALAPPDATA\ai.secrets"; pnpm install --frozen-lockfile; pnpm build
# Shim on PATH (per user):
$bin = "$env:LOCALAPPDATA\Microsoft\WindowsApps"
Set-Content "$bin\secrets-ai.cmd" "@node `"$env:LOCALAPPDATA\ai.secrets\dist\cli\index.js`" %*"
secrets-ai init --provider openrouter    # hidden key prompt
secrets-ai serve                          # window 1
secrets-ai chat                           # window 2
```

- Config lives in `%APPDATA%\secrets-ai` and is protected by your profile ACLs (chmod is a no-op on Windows).
- Colors are ANSI and are used only when the output is a console. Set `NO_COLOR=1` to disable them.
- To start at logon, create a Task Scheduler task that runs `secrets-ai.cmd serve` at log on for your user, with "Run only when user is logged on".
- WSL2 also works. Follow the Linux instructions inside the distro.
