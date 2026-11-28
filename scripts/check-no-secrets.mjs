#!/usr/bin/env node
// Fails if tracked files look like they contain real keys or a committed .env / opencode.json.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const bad = [];
for (const f of files) {
  if (/(^|\/)\.env$/.test(f) || /(^|\/)\.env\.(?!example$)/.test(f) || /(^|\/)auth\.json$/.test(f)) bad.push(`${f}: secret file must not be committed`);
  if (/\.(png|jpg|ico|lock|yaml)$/.test(f)) continue;
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  const m = text.match(/sk-or-v1-[a-f0-9]{32,}|AIza[0-9A-Za-z_-]{35}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}/);
  if (m) bad.push(`${f}: looks like a real credential (${m[0].slice(0, 8)}...)`);
}
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(`check-no-secrets: ${files.length} files clean`);
