# PRD 7 — agent-canvas sourced from the OpenHands monorepo

**Summary**

The `packages/agent-canvas` subtree now imports the Agent Canvas frontend from the
OpenHands monorepo, OpenHands/OpenHands, instead of the standalone
OpenHands/agent-canvas repository. The monorepo's repository root *is* the
`@openhands/agent-canvas` package (same `package.json` name, same layout —
`packages/agent-canvas/vite.config.ts`, `packages/agent-canvas/src/`,
`packages/agent-canvas/scripts/static-server.mjs`,
`packages/agent-canvas/scripts/ingress.mjs`,
`packages/agent-canvas/scripts/proxy-utils.mjs`, the `dev:frontend` and `build`
scripts). The standalone repository is the retired previous source and no longer
receives the frontend releases this workspace tracks.

The directory prefix stays `packages/agent-canvas` and the git remote keeps the
name `agent-canvas`, because both are depended on by the launcher, the ecosystem,
the ingress and production-frontend wrappers, the justfile sync recipes, and every
PRD that references paths inside the prefix. Only two things redirect to the
monorepo: the remote's *URL*, and the GitHub *release-slug* the sync recipe
queries for the `latest` ref.

**Scope**

Workspace-owned files:

- `justfile` — the `setup-remotes` recipe (the `agent-canvas` remote URL) and the
  `sync-subtree` / `sync-canvas` recipes (the release-fetch slug).
- `AGENTS.md` — the upstream table, the layout comment, the ownership table, the
  subtree-maintenance table and prose, and the fork-workflow remote URL.
- `README.md` — the included-packages table, the layout comment, the subtree-remotes
  example, and the update-packages section.
- `docs/prd/7_agent-canvas-source-monomrepo.md` — this file.

Upstream files modified: none. The change re-imports the upstream tree unchanged;
no `WORKSPACE-PATCH` is introduced.

**Functional requirements**

1. **FR1** — The `agent-canvas` git remote points at
   `https://github.com/OpenHands/OpenHands.git` (the monorepo), recorded idempotently
   by `just setup-remotes`.
2. **FR2** — `git fetch --no-tags agent-canvas refs/tags/<tag>` resolves a tag from
   the monorepo, so a release-tagged frontend tree can be merged into the prefix.
3. **FR3** — `just sync` and `just sync-canvas` resolve the `latest` ref to the most
   recent GitHub release on the *monorepo* (OpenHands/OpenHands), not the retired
   standalone repo, then `git subtree merge` that tag into `packages/agent-canvas`.
4. **FR4** — The directory prefix remains `packages/agent-canvas` and the remote name
   remains `agent-canvas`; neither is renamed, so no consumer (launcher, ecosystem,
   justfile recipes, PRD path references, wrappers) is disturbed.
5. **FR5** — The subtree shares a single ancestry line on the new remote going
   forward: it was re-established with `git subtree add` from the monorepo's release
   tag, so subsequent `just sync-canvas` merges against that common history rather
   than mixing the two repos' divergent histories.
6. **FR6** — The first re-import landed the monorepo's latest release at the time
   of the switch (tag `v1.8.0`, `@openhands/agent-canvas` 1.8.0).

**Non-functional requirements**

1. **NFR1** — Minimal and additive. No upstream file inside `packages/` is patched;
   the only edits are workspace-owned configuration and documentation. The
   standalone→monorepo switch is a re-import of an unmodified upstream tree.
2. **NFR2** — Stable identifiers. The prefix path and the remote name are unchanged,
   so existing `WORKSPACE-PATCH` markers and PRD path references remain valid.
3. **NFR3** — No new dependencies or tooling. The sync mechanism is unchanged in
   kind (git subtree + a GitHub releases query); only a slug is parameterised.
4. **NFR4** — The fork workflow notes that a canvas contribution is now pushed to a
   fork of the monorepo (OpenHands/OpenHands), not the retired standalone repo.
5. **NFR5** — The change is one concern: redirecting the agent-canvas source. It is
   committed separately from the subtree re-import where practical, per the
   one-concern-per-commit rule; the re-import itself is a `git subtree add` commit.

**Decision points**

- **Keep the remote name `agent-canvas`, change only its URL.** Considered renaming
  the remote to `openhands-monorepo` or `OpenHands`. Rejected: the `sync-subtree`
  recipe keys the fetch remote and the prefix off `{{name}}`, and every PRD and the
  ecosystem reference the prefix; renaming would be a large, surface-wide change for
  no behavioural benefit. Renaming the URL alone (and parameterising the release
  slug) is the minimal, additive edit.
- **Parameterise the release slug rather than the remote/prefix.** The
  `sync-subtree` recipe gained an optional `repo` parameter (defaulting to the
  remote/prefix `name`) used only for the GitHub releases query. This lets
  `sync-canvas` pass `OpenHands` while `sync-sdk` is unchanged (`software-agent-sdk`
  slug), so the SDK recipe and its default behaviour are untouched.
- **Re-establish the subtree with `git subtree add`, not a content-only replace.**
  Considered deleting `packages/agent-canvas` and copying the monorepo root tree in
  as ordinary tracked files. Rejected: a content-only replacement has no subtree
  ancestry, so the next `just sync-canvas` could not `git subtree merge` cleanly.
  Removing the prefix then `git subtree add`-ing the release tag establishes the
  new ancestry line, satisfying the common-history requirement going forward.
- **Import the monorepo root as the tree.** The monorepo exposes the frontend at its
  root (its `package.json` is literally `@openhands/agent-canvas`). There is no
  subdirectory to extract, so the whole root becomes `packages/agent-canvas/`. This
  brings extra top-level workspace-adjacent directories (e.g. `__tests__/`,
  `electron/`, `.github/`, `.husky/`) into the prefix; they are the upstream layout
  and are preserved as-is per the modular-and-additive rules. None of them is
  wired into the workspace's own `.github/`, tooling, or hooks at the repository
  root — the subtree's own copies live under `packages/agent-canvas/`.

**Assumptions**

These are the tripwires to re-check first whenever upstream (the monorepo) changes:

- The monorepo root remains the `@openhands/agent-canvas` frontend (its root
  `package.json` `name` is `@openhands/agent-canvas`). Re-check on every sync; if the
  frontend moves into a subdirectory, the subtree add/merge prefix strategy must
  change (an extraction step or a different `--prefix` mapping).
- The release tags the workspace syncs to continue to be published on
  OpenHands/OpenHands and to tag a tree that is the frontend root. If releases stop
  being tagged on the monorepo, `just sync-canvas`'s `latest` resolution breaks;
  fall back to an explicit `<ref>` (a tag or commit) until resolved.
- The consumed upstream seams are unchanged at the imported ref: the
  `packages/agent-canvas/scripts/static-server.mjs`,
  `packages/agent-canvas/scripts/ingress.mjs`,
  `packages/agent-canvas/scripts/proxy-utils.mjs` CLI surfaces (PRDs 1, 4, 6), the
  `packages/agent-canvas/vite.config.ts` dev-proxy prefix list (PRD 1), and the
  `dev:frontend` / `build` package scripts. These were verified present at
  `v1.8.0`. Re-check the corresponding "Re-check on upstream sync" notes in PRDs 1,
  4, and 6 after every sync.
- The standalone OpenHands/agent-canvas repository stays retired as the frontend
  source. If it is resurrected as the canonical source again, redirect the remote
  URL and the release slug back and re-establish the subtree from it.
- `git subtree add`/`merge` semantics and the `git-subtree-dir:` metadata it relies
  on for finding the last imported commit are unchanged.

**Upstream divergence**

There is no code divergence inside `packages/`: the imported tree is the upstream
monorepo frontend root, unmodified. The divergence is purely in *which* upstream
supplies the tree: the standalone OpenHands/agent-canvas (retired) versus the
OpenHands/OpenHands monorepo (the live canonical home of the frontend). This change
cannot live upstream because it is a workspace sourcing decision, not a change to
either upstream repository. It would be retired only if the workspace reverted to
the standalone repo as its source.

**Conflict resolution notes**

- On a future `just sync-canvas` `git subtree merge` conflict, resolve from the
  requirements here, not from any old diff: re-check FR1–FR6 against the new
  monorepo tree, preserve the `packages/agent-canvas` prefix and the `agent-canvas`
  remote name, and re-verify the Assumptions (especially the root-as-frontend
  assumption and the consumed-script seams).
- The justfile `sync-subtree` `repo` parameter is the only recipe-level seam for the
  source repository; keep it defaulting to `name` so the SDK recipe stays
  source-neutral, and keep `sync-canvas` the only caller that overrides it.
- Workspace-owned documentation (AGENTS.md, README.md, this PRD) is the authoritative
  description of the source; the justfile comments echo it but are not the source of
  truth.

**Status**

active
