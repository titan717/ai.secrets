/**
 * MCP server presets for the generated opencode.json. Secrets are only referenced via
 * `{env:VAR}`; OpenCode substitutes them from the child's environment at load time.
 */

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
/** Toolsets exposed to the model (sent as the X-MCP-Toolsets header). */
export const GITHUB_TOOLSETS = ["context", "repos", "issues", "pull_requests"] as const;

/** OpenCode names MCP tools `<server>_<tool>`; permission keys use the same names (wildcards allowed). */
export const GITHUB_SERVER = "github";
export const SECRETS_SERVER = "secrets";

/** GitHub MCP tools that change state. Everything else in the chosen toolsets is read-only. */
export const GITHUB_WRITE_TOOLS = [
  "create_branch",
  "create_or_update_file",
  "delete_file",
  "push_files",
  "create_repository",
  "fork_repository",
  "create_issue",
  "issue_write",
  "update_issue",
  "add_issue_comment",
  "sub_issue_write",
  "add_sub_issue",
  "remove_sub_issue",
  "reprioritize_sub_issue",
  "assign_copilot_to_issue",
  "create_pull_request",
  "update_pull_request",
  "update_pull_request_branch",
  "merge_pull_request",
  "pull_request_review_write",
  "create_pending_pull_request_review",
  "add_comment_to_pending_review",
  "submit_pending_pull_request_review",
  "delete_pending_pull_request_review",
  "create_and_submit_pull_request_review",
  "add_reply_to_pull_request_comment",
  "request_copilot_review",
  "create_gist",
  "update_gist",
] as const;

/** Read-only prefixes/names in the context/repos/issues/pull_requests toolsets. */
export const GITHUB_READ_PATTERNS = ["get_*", "list_*", "search_*", "*_read"] as const;

export const SECRETS_READ_TOOLS = ["read_conversation", "summarize_dock_channel"] as const;
/** draft_message never sends anything, but it is still gated so the user sees each draft request. */
export const SECRETS_WRITE_TOOLS = ["draft_message"] as const;

export function githubMcpEntry(): Record<string, unknown> {
  return {
    type: "remote",
    url: GITHUB_MCP_URL,
    headers: {
      Authorization: "Bearer {env:GITHUB_TOKEN}",
      "X-MCP-Toolsets": GITHUB_TOOLSETS.join(","),
    },
    enabled: true,
  };
}

export function secretsMcpEntry(opts: { nodePath: string; entry: string; apiUrl: string }): Record<string, unknown> {
  return {
    type: "local",
    command: [opts.nodePath, opts.entry],
    environment: { SECRETS_API_URL: opts.apiUrl, SECRETS_TOKEN: "{env:SECRETS_TOKEN}" },
    enabled: true,
  };
}

type Action = "allow" | "ask" | "deny";

/**
 * Permission rules for MCP tools. OpenCode evaluates rules in insertion order with the LAST
 * match winning, so the catch-all comes first, then read allows, then write overrides.
 */
export function mcpPermissions(servers: { github: boolean; secrets: boolean }, writeAction: Action = "ask"): Record<string, Action> {
  const p: Record<string, Action> = {};
  if (servers.github) {
    p[`${GITHUB_SERVER}_*`] = writeAction;
    for (const r of GITHUB_READ_PATTERNS) p[`${GITHUB_SERVER}_${r}`] = "allow";
    for (const w of GITHUB_WRITE_TOOLS) p[`${GITHUB_SERVER}_${w}`] = writeAction;
  }
  if (servers.secrets) {
    p[`${SECRETS_SERVER}_*`] = writeAction;
    for (const r of SECRETS_READ_TOOLS) p[`${SECRETS_SERVER}_${r}`] = "allow";
    for (const w of SECRETS_WRITE_TOOLS) p[`${SECRETS_SERVER}_${w}`] = writeAction;
  }
  return p;
}
