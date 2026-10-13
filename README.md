# Foundocs setup

Use the installation prompt from your project's Foundocs integration guide. It contains a ten-minute, one-use connection code, never an API key. The coding agent fixes an absolute project root and sends the prompt's JSON to the installer's **private stdin** using a process tool. Do not paste the JSON into shell command text, argv, logs, or a committed file.

Version **0.3.3** omits routine configuration-file and pathname announcements in the bundled skills and generated agent instructions. Configuration is still resolved and validated internally; agents mention it when asked or when explaining a configuration problem. For local development verification, build this package and run from its directory:

```text
node src/cli.mjs install --root /absolute/project
node src/cli.mjs doctor --root /absolute/project
node src/cli.mjs rollback --root /absolute/project
```

The install command reads stdin until EOF. Commands never take codes or API keys as arguments. This package requires Node.js 22.19.0+ and a locally installed Claude Code or Codex CLI. Before exchanging the code it inspects the installed CLI's actual helper support, parses existing settings and checks private storage permissions. Missing or incompatible CLIs require installation/update or the manual guide. Codex's desktop app without its CLI cannot pass this automatic feature check.

Input JSON follows `SetupInstallInput` version 1: `client` (`claude` or `codex`), `projectId`, `workspaceId`, `attemptId`, `code`, `exchangeUrl`, `mcpUrl`, and `version: 1`. The code is exchanged once for an installation key; same-attempt reruns reuse that private key. A newly issued attempt can replace a revoked key while retaining the previous key privately. Existing keys are never automatically revoked.

Configuration is local to the exact `--root`: `foundocs.json`, a marked `AGENTS.md` block, and either `.codex/config.toml` or `.mcp.json`. Claude additionally receives a marked `CLAUDE.md` reference to `AGENTS.md`. The package also installs its English Foundocs skill at `.agents/skills/foundocs/` for Codex or `.claude/skills/foundocs/` for Claude, including the Dreaming protocol reference. The managed instruction block points to the selected client’s discoverable skill. Existing instructions and foreign MCP entries are preserved. Skill files are updated only when unchanged from the installer’s recorded version; foreign or user-edited skills stop preflight, and rollback preserves later user edits. Run `update-skills` to add the bundled skills to an older installation without a new connection code. Dreaming itself requires the connected server to expose `dream_memory` and `get_dream`; installation does not enable unavailable server capabilities. Conflicting project IDs, malformed files, symlinks, or a different same-name `foundocs` server stop installation before exchanging the code. Resolve a conflict explicitly; this installer does not overwrite it.

Keys, backups and installation journals live in `~/.local/share/foundocs/setup`, outside the project. `FOUNDOCS_SETUP_HOME` may select another absolute private directory outside the target project, including isolated test fixtures. Keep using that same value for doctor/rollback. Credentials are isolated by workspace, project, and canonical project root. Durable authentication helpers are copied there; MCP settings use the absolute Node executable and these helpers, independent of npm cache lifetime. Claude Code uses its HTTP `headersHelper`. Codex 0.149.1 reserves `Authorization` in its HTTP helper, so Codex uses a bundled local stdio adapter that forwards MCP tool discovery and calls to the same Remote HTTP endpoint with the saved Bearer key. This adapter preserves remote schemas, annotations, structured results and errors, and requires an explicit valid project ID on every call. A changed valid project ID is forwarded unchanged; the remote server enforces workspace access. It adds no remote service. macOS/Linux use user-only directories/files (0700/0600). Windows uses PowerShell to apply and verify a protected current-user-only ACL; unsupported ACL filesystems stop before code exchange.

The helper prefers the saved installation credential. To explicitly use a process-provided `FOUNDOCS_API_KEY`, also provide matching `FOUNDOCS_PROJECT_ID` and `FOUNDOCS_WORKSPACE_ID`. An unrelated shell key never silently overrides the saved workspace key. The helper's stdout contains authentication headers solely for the host MCP client; do not invoke it through tools that log stdout.

Version 0.2.0 recognizes recorded 0.1.x installations in their original private location. Reinstalling migrates their project filename, managed instruction markers and selected client's server name while retaining credential paths and the rollback journal. Existing doctor and rollback commands can discover the old location. Two recorded default locations are treated as a conflict; choose the intended location explicitly with `FOUNDOCS_SETUP_HOME`. A historical custom storage override remains supported when no current override is supplied. Credentials and helper directories are never moved automatically.

Migration refuses differing project IDs, foreign or duplicate server entries, malformed/mixed instruction markers and unsafe files before exchanging a code. It writes the new project configuration before replacing managed instructions and removes the old filename last. Every file write is atomic and journaled; the multi-file operation is recoverable rather than transactional. A retry reuses the same saved key. Rollback preserves the original installation baseline if an older journal exists; otherwise it restores the files as they were before migration. Manually changed or inline historical TOML server definitions require explicit conflict resolution. The private compatibility module also accepts a complete, matching historical credential namespace, only when no current credential variable is present.

Doctor performs MCP initialize, tool discovery, and `get_project_context` with the exact project ID. `diagnostic_passed` means the independent diagnostic succeeded. You must still trust/reconnect the project in the selected host and call its MCP tool to verify that host. Setup never reports host connection from file creation alone.

For response loss or failure before private key storage, the error reports the attempt ID and guide recovery route: inspect/revoke only that attempt's issued key and generate a new code. After key storage, rerun the same installation input. `rollback` restores only files still matching the installer-written content; concurrent edits are retained and reported. It preserves private credentials for retry. A stale operation lock after process interruption is never automatically deleted: confirm no installer is running before removing the reported private lock file.

## Verification status

The implementation includes unit/integration tests for both configuration formats, preservation, reruns, conflicts, credential isolation, redaction, recovery, rollback, protocol diagnostics, path quoting and ACL command generation. Local feature checks pass on macOS with Codex CLI 0.149.1 and Claude Code 2.1.284. Windows/Linux command paths are implemented, but real runtime verification on those operating systems is still required before claiming them verified. These automated tests use isolated host capability fixtures and do not claim that a real host connected successfully.

Development: `npm ci`, `npm test`, and `npm run typecheck`.


## Knowledge skills (0.3.1)

The 0.3.1 source includes the English `foundocs-capture-knowledge` skill and writing guide, plus the `foundocs` Dreaming skill and protocol reference. `install` copies the same bundle into `.agents/skills/` for Codex or `.claude/skills/` for Claude Code, and adds the exact skill link plus document/knowledge policy to its managed AGENTS block. Claude also receives the existing CLAUDE reference. Explicit user destinations and repository spec conventions take precedence over default Foundocs storage.

Existing recorded installations can update the skill and managed instructions without supplying a connection code, contacting the service or rotating credentials:

```text
node /absolute/path/to/foundocs-setup/src/cli.mjs update-skills --root /absolute/project
```

The equivalent command for this release is `npx --yes @foundocs/foundocs-setup@0.3.3 update-skills --root /absolute/project`. The local commands above run this checkout; a pinned npm command requires that registry release to exist.

Updates preserve MCP settings, project configuration, authentication helpers and private keys, including installations that still use the historical configuration filename. The private `skills.json` records installed/pending asset hashes for interruption recovery. Foreign same-name files and local skill edits stop installation/update before project writes; move or reconcile the reported file explicitly, then retry. Unrelated skills and instructions are retained. `rollback` includes skill assets and preserves concurrent edits.

`doctor` reports missing, outdated or conflicting skill files separately from MCP diagnostics and points to `update-skills`. A successful `skills.status: installed` verifies files only; the selected host must still discover the skill after reconnection/restart when needed. Neither setup nor doctor claims that a model executed the skill or will always follow it. No skill hooks or background collection are installed.

The package's `skills/` and `templates/` directories must be included in every tarball. Run package tests and a packed-CLI smoke check before publishing; keep production's exact version pinned to a registry-verified release.

Dreaming adversarial fixtures and trace checks live in `eval/`; see `eval/README.md`. These checks do not claim real-model quality evaluation.

## Update offers

The managed AGENTS block and Foundocs skill guide the agent to run the bundled `foundocs/scripts/check-update.mjs` once on the first Foundocs use in a session. This is guidance, not an installed host session-start hook. The Node script only queries public npm metadata: it does not download or execute another package, send project identifiers or credentials, or change project files.

Each project has a private cache under `~/.local/share/foundocs/setup/update-checks` (or the same subdirectory of `FOUNDOCS_SETUP_HOME`). Checks and repeated offers are limited to once per 24 hours. A newer stable release includes its published summary when available; missing summaries are reported as unavailable. Network, runtime and cache failures quietly leave ordinary work usable.

The agent asks before updating, pins the command to the exact offered version and confirms the existing installer's result. Choosing later defers that version for seven days; a different newer release can be offered after the check cache expires. Existing ownership checks continue to protect edited skills, and updates preserve connection settings and keys. Installations predating the checker need one manual `update-skills` to acquire it. The installer writes `foundocs/release.json` with the installed package version and manages the checker and guide through the same update/rollback lifecycle.

## Source and releases

This repository contains the installer, bundled agent skills, templates and tests for `@foundocs/foundocs-setup`. The Foundocs application and server are maintained separately. Use this repository for installer changes and releases.

Releases are published from GitHub Actions using npm Trusted Publishing (OIDC), without a stored npm write token. A public repository allows npm provenance to link a published package to the exact source commit and workflow; it does not certify the code's safety. Existing releases published before this workflow do not gain provenance retroactively.

One-time maintainer setup in the npm package's **Settings → Trusted Publisher**:

- Provider: GitHub Actions
- Organization or user: `foundocs`
- Repository: `foundocs-setup`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Allow direct publishing with `npm publish`; stage-only publishing requires a manual approval.

Complete the first publish within npm's configuration validation window (currently two days). If that window expires, recreate the publisher configuration before releasing.

To release after reviewing and merging the package changes into `main`:

```sh
npm ci
npm test
npm run typecheck
npm version patch
git push origin main
git push origin --follow-tags
```

`npm version patch` creates a version commit and annotated `vX.Y.Z` tag. The publish workflow validates the tag against `package.json`, runs the tests, builds the package and publishes it publicly with provenance. Each npm version can only be published once; use a new version for the first automated release if the current version already exists.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
