# PRD 7: Conversation Worktree Setup

## Summary
Per-conversation git worktrees are, by default, created by the agent-server under its built-in `/tmp/conversation-worktrees` root — a location that is volatile, not gitignored, and not isolated per checkout. Upstream made that root configurable (`OH_CONVERSATION_WORKTREE_ROOT`, see upstream software-agent-sdk PR 4362). This workspace consumes that env var instead of working around the old hard-coded path: the launcher resolves the worktree root and the ecosystem fans it out to the backend, so worktrees land in the checkout's cleanable data tree (or an operator-chosen location). The earlier `/tmp`-symlink recipe this PRD used is retired.

## Scope
| Path | Ownership | Purpose |
| --- | --- | --- |
| `scripts/launch-stack.js` | Workspace | Resolves the conversation worktree root (flag → env → default) and exports it to the ecosystem as a `STACK_` value. |
| `ecosystem.config.js` | Workspace | Fans the resolved root out to the backend app as `OH_CONVERSATION_WORKTREE_ROOT`, the env var the upstream agent-server reads. |
| `docs/prd/7_conversation-worktree-setup.md` | Workspace | This PRD. |

No upstream files are modified; the `OH_CONVERSATION_WORKTREE_ROOT` seam is provided by the imported `software-agent-sdk` subtree (upstream PR 4362) and is consumed, not patched.

## Functional Requirements
1. **FR1** — The launcher resolves the conversation worktree root using this precedence: (a) the `--conversation_worktree_root` flag, (b) the `OH_CONVERSATION_WORKTREE_ROOT` environment variable, (c) the default `<workspace_dir>/worktrees`. It exports the resolved absolute path to the ecosystem as `STACK_CONVERSATION_WORKTREE_ROOT`.
2. **FR2** — The launcher expands a leading `~` in a flag or env value to the home directory, so shell-profile values such as `~/data/worktrees` resolve the way a shell would.
3. **FR3** — The ecosystem sets `OH_CONVERSATION_WORKTREE_ROOT` on the backend app from the value the launcher resolved. It is set on the backend only — not on the frontend or ingress apps.
4. **FR4** — With the backend configured this way, per-conversation git worktrees are created under `<root>/<conversation_id>/<repo_name>` (the agent-server's layout) instead of the built-in `/tmp/conversation-worktrees` default.
5. **FR5** — The workspace-owned default location lives inside the gitignored workspace data tree, so worktrees are cleaned with the rest of the checkout's agent-server data.

## Non-Functional Requirements
1. **NFR1** — Resolution is pure and part of the launcher's resolution function (no side effects; observable via `--dry-run`); the ecosystem fans the value out like the other `OH_*` data paths and derives nothing of its own.
2. **NFR2** — The stack stays unprivileged and writes only under the workspace data tree or an operator-specified path; it never creates a `/tmp` symlink or requires elevated access.
3. **NFR3** — A user who already set `OH_CONVERSATION_WORKTREE_ROOT` in their shell continues to be honored (the env branch), so no existing configuration is broken by this change.
4. **NFR4** — The default keeps the worktree root in the same per-checkout data tree as conversations and bash events, preserving per-checkout git-worktree isolation.

## Decision Points
1. **DP1** — Consume the upstream env var vs. keep the `/tmp` symlink.
   - Decision: consume the upstream env var. Upstream merged PR 4362, which made the worktree root configurable; the env seam is native, needs no `/tmp` write or symlink, and retires the earlier workaround. The symlink only existed to patch over the pre-4362 hard-coded `/tmp/conversation-worktrees` path.
2. **DP2** — Default location: `<workspace_dir>/worktrees` vs. the upstream `/tmp/conversation-worktrees`.
   - Decision: `<workspace_dir>/worktrees`. It co-locates the worktrees with the other agent-server data the launcher already isolates per checkout (`OH_WORKSPACE_PATH`, `OH_CONVERSATIONS_PATH`, `OH_BASH_EVENTS_DIR`), so the whole tree is gitignored and cleanable. An operator who wants `/tmp` (or any other path) can still set the flag or env var.
3. **DP3** — Precedence flag > env > default.
   - Decision: match the launcher's other resolvers (`--workspace_dir` over the `WORKSPACE_DIR` env over the default; binds as flag > legacy env > loopback) so the flag surface has one mental model.

## Assumptions
1. **A1** — The imported `software-agent-sdk` subtree includes upstream PR 4362: the agent-server `Config` exposes `conversation_worktree_root` (default `/tmp/conversation-worktrees`) and reads `OH_CONVERSATION_WORKTREE_ROOT` (the `OH_` env prefix plus the field name). Re-check on every SDK subtree sync.
2. **A2** — The agent-server creates the worktree root and its per-conversation subdirectories itself at conversation-creation time (a recursive, idempotent mkdir); the workspace does not pre-create them.
3. **A3** — The launcher and ecosystem are the only seams between the workspace and the backend (the backend is the SDK venv's `agent-server` console script, not a workspace entry shim), so fanning out one env var is sufficient.
4. **A4** — `<workspace_dir>` (and therefore `<workspace_dir>/worktrees`) is gitignored in this workspace.

## Upstream Divergence
No upstream code is modified. The workspace consumes an upstream-provided config seam (`OH_CONVERSATION_WORKTREE_ROOT`, added in PR 4362) through the launcher/ecosystem env fan-out. The workspace's default location (`<workspace_dir>/worktrees`) differs from the upstream default (`/tmp/conversation-worktrees`); that is a workspace deployment choice, not a code change, and requires no upstream support. The earlier `/tmp/conversation-worktrees` symlink recipe (this PRD's prior revision) is retired because it only existed while the agent-server hard-coded `/tmp` before PR 4362.

## Conflict Resolution Notes
Preserve the requirement — conversation worktrees live in an operator-configurable, per-checkout-cleanable root — not the mechanics. If the SDK changes how the root is configured (renames the env var or the `Config` field, or stops reading `OH_*` for it), re-locate the current config seam and re-point the fan-out; any requirement may be re-implemented with different mechanics, none may be dropped silently. If the SDK subtree is ever synced to a commit that predates PR 4362 (a downgrade), the env seam disappears and a compatibility shim must be re-introduced.

## Status
Active. Supersedes this PRD's prior revision (the `/tmp`-symlink `setup-conversation-worktree` recipe).
