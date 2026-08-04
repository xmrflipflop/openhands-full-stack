# PRD: Configurable conversation worktree root

**Status:** Active

## Summary

Make the conversation worktree root directory configurable through environment variables and configuration files instead of being hardcoded to `/tmp/conversation-worktrees`. This allows deployments to choose a different base directory for git worktrees, which is useful when:
- `/tmp` has limited space or is mounted with `noexec`
- Worktrees need to be on the same filesystem as the source repositories for performance
- Deployments want to control cleanup policies or backup strategies for worktree directories

## Scope

Workspace-owned code only; no upstream files modified inside `packages/` (the configuration is passed through the existing config system).

| Path | Role |
| --- | --- |
| `packages/software-agent-sdk/openhands-agent-server/openhands/agent_server/config.py` | Added `conversation_worktree_root` field to `Config` class with default `/tmp/conversation-worktrees` |
| `packages/software-agent-sdk/openhands-agent-server/openhands/agent_server/conversation_service.py` | Modified `ConversationService` to accept and use `conversation_worktree_root`; updated `_create_conversation_worktree` and `_prepare_request_workspace` to receive it as parameter |
| `packages/software-agent-sdk/openhands-agent-server/openhands/agent_server/init_router.py` | Added `conversation_worktree_root` field to `InitRequest` for deferred-init mode |
| `packages/software-agent-sdk/tests/agent_server/test_conversation_service.py` | Updated tests to use the configured value instead of patching the old constant |

## Functional requirements

- **FR1** — The `Config` class exposes a `conversation_worktree_root: Path` field with default `Path("/tmp/conversation-worktrees")` so existing deployments see no behavior change.
- **FR2** — The field can be overridden via `OH_CONVERSATION_WORKTREE_ROOT` environment variable (automatic through the existing `EnvParser` for `Path`).
- **FR3** — The field can be overridden via the JSON config file at `OPENHANDS_AGENT_SERVER_CONFIG_PATH` (default location is a runtime-created file).
- **FR4** — `ConversationService` accepts `conversation_worktree_root` in its constructor (with the same default) and stores it as an instance attribute.
- **FR5** — `ConversationService.get_instance(config)` passes `config.conversation_worktree_root` to the constructor.
- **FR6** — `_create_conversation_worktree()` and `_prepare_request_workspace()` receive `conversation_worktree_root` as an explicit parameter instead of using the module-level constant.
- **FR7** — The `InitRequest` model (used for deferred-init `/api/init`) includes an optional `conversation_worktree_root` field so warm-pool deployments can set it per-user at initialization time.
- **FR8** — `_build_initialized_config()` merges `conversation_worktree_root` from the init request into the running config.
- **FR9** — All existing tests pass without modification of their logic (only the test fixture setup changed to pass the value explicitly).

## Non-functional requirements

- **NFR1** — Backward compatible: the default value is identical to the old hardcoded constant, so existing deployments require no changes.
- **NFR2** — No breaking changes to public REST APIs or WebSocket contracts.
- **NFR3** — The configuration follows the existing pattern used by `conversations_path`, `workspace_path`, and `bash_events_dir`.
- **NFR4** — The env var name follows the `OH_*` convention (`OH_CONVERSATION_WORKTREE_ROOT`).

## Decision points

- **Approach chosen**: Add a new config field and thread it through to the worktree creation functions. This follows the existing pattern for configurable paths in the agent-server.
- **Alternative considered**: Keep a module-level constant but read from env var at module load time. Rejected because it wouldn't integrate with the config file system, the deferred-init flow, or the existing `Config` pattern.
- **Alternative considered**: Make it a field on `StartConversationRequest`. Rejected because the worktree root is a server-wide deployment concern, not a per-conversation setting.

## Assumptions

- The `Path` env parser (which uses `StrEnvParser` internally) correctly handles absolute paths from environment variables.
- The deferred-init flow merges config fields correctly (verified by existing tests for other fields like `conversations_path` and `bash_events_dir`).
- Tests that previously patched `CONVERSATION_WORKTREE_ROOT` can be updated to use the fixture's `conversation_worktree_root` attribute.

## Upstream divergence

None. This change is entirely within the workspace's agent-server configuration and conversation service; no upstream packages are modified.

## Conflict resolution notes

If an upstream sync changes the signature of `_create_conversation_worktree` or `_prepare_request_workspace`, or adds new code paths that create worktrees, the new code paths must also receive and use `conversation_worktree_root` from the `ConversationService` instance (or `Config`). The requirement is that the worktree root is always sourced from configuration, never from a hardcoded constant.

## Status

Active. This PRD documents the configuration addition for conversation worktree root directory.