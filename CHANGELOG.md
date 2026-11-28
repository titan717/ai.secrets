# Changelog

All notable changes to ai.secrets. Dates are UTC.

## [Unreleased]

### Changed
- Rebuilt from scratch as an OpenCode bridge. The previous implementation targeted OpenCode routes and events that do not exist in OpenCode 1.19.6, so it is removed, together with the serverless deploy configs (Vercel/Railway/Render), which cannot supervise a child process.

### Added
- `docs/OPENCODE-NOTES.md`: OpenCode facts verified against the real binary (routes, event lifecycle, opencode.json, key injection, per-model reasoning variants).
- Six real OpenCode event traces (`tests/fixtures/traces`), a scripted OpenAI-compatible mock LLM, and `scripts/record-traces.mjs`.
- `src/core`: event contract, HTTP API contract, presets contract, settings validation, 0600 auth/token store, redaction and logger.
- CI on Linux/macOS/Windows plus a real-OpenCode e2e job.
