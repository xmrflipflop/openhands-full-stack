# PRD 7: Conversation Worktree Setup

## Summary
The workspace currently uses a hardcoded path `/tmp/conversation-worktrees/` for conversation worktrees. This PRD adds a configurable location via the environment variable `OH_CONVERSATION_WORKTREE_ROOT` and a new `just setup-conversation-worktree` recipe that sets up the symlink. The existing `just setup` recipe will be extended to run this new recipe.

## Scope
| Path | Ownership | Purpose |
| --- | --- | --- |
| `justfile` | Workspace | Add `setup-conversation-worktree` recipe and extend `setup` recipe |
| `docs/prd/7_conversation-worktree-setup.md` | Workspace | This PRD |

## Functional Requirements
1. **FR1**: Add a new `just` recipe `setup-conversation-worktree` that:
   - Reads the environment variable `OH_CONVERSATION_WORKTREE_ROOT`
   - If set, runs `mkdir -p $OH_CONVERSATION_WORKTREE_ROOT`
   - If set, removes any existing `/tmp/conversation-worktrees/` directory/symlink
   - If set, creates a symlink `ln -s $OH_CONVERSATION_WORKTREE_ROOT /tmp/conversation-worktrees`
   - If unset, does nothing and exits successfully
2. **FR2**: Extend the existing `just setup` recipe to also run `setup-conversation-worktree`
3. **FR3**: The recipe should be idempotent (safe to run multiple times)

## Non-Functional Requirements
1. **NFR1**: The recipe must not fail if `OH_CONVERSATION_WORKTREE_ROOT` is unset
2. **NFR2**: The recipe must handle the case where `/tmp/conversation-worktrees` already exists as a directory or symlink
3. **NFR3**: The recipe should use POSIX-compliant shell syntax for portability

## Decision Points
1. **DP1**: Should the recipe be in the justfile or a separate script?
   - Decision: Keep it in the justfile since it's a simple shell sequence and follows the pattern of other simple recipes in the justfile
2. **DP2**: Should we validate that the target directory is writable?
   - Decision: Let `mkdir -p` and `ln -s` surface any permission errors naturally; no pre-validation needed

## Assumptions
1. **A1**: The hardcoded path `/tmp/conversation-worktrees/` is used by upstream code that we cannot easily change
2. **A2**: The `just setup` recipe exists and is the canonical one-time setup command
3. **A3**: Users who want a custom worktree location will set `OH_CONVERSATION_WORKTREE_ROOT` in their environment or `.env` file

## Upstream Divergence
- This is workspace-only functionality; no upstream changes required
- The symlink approach preserves compatibility with any hardcoded references to `/tmp/conversation-worktrees/` in the imported packages

## Conflict Resolution Notes
- If upstream adds similar functionality, we can retire this PRD and adopt the upstream approach
- The justfile recipe is workspace-owned and will not conflict with upstream merges

## Status
Active