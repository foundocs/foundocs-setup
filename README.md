# Foundocs setup

Use the installation prompt from your project's Foundocs integration guide. It contains a ten-minute, one-use connection code, never an API key. The coding agent fixes an absolute project root and sends the prompt's JSON to the installer's **private stdin** using a process tool. Do not paste the JSON into shell command text, argv, logs, or a committed file.

Version **0.3.5** extends portable project MCP settings to Claude Code. Both clients run the shared exact-version npm runtime while each installation key stays in private local storage. Existing owned Codex absolute-path and Claude HTTP helper configurations can migrate without exchanging a code or rotating a key. For local development verification, build this package and run from its directory:

```text
node src/cli.mjs install --root /absolute/project
node src/cli.mjs doctor --root /absolute/project
node src/cli.mjs rollback --root /absolute/project
node src/cli.mjs migrate --root /absolute/project
```

The install command reads stdin until EOF. Commands never take codes or API keys as arguments. This package requires Node.js 22.19.0+ and a locally installed Claude Code or Codex CLI. Before exchanging the code it inspects the installed CLI's project stdio MCP support, parses existing settings and checks private storage permissions. Missing or incompatible CLIs require installation/update or the manual guide. Codex's desktop app without its CLI cannot pass this automatic feature check.

Input JSON follows `SetupInstallInput` version 1: `client` (`claude` or `codex`), `projectId`, `workspaceId`, `attemptId`, `code`, `exchangeUrl`, `mcpUrl`, and `version: 1`. The code is exchanged once for an installation key; same-attempt reruns reuse that private key. A newly issued attempt can replace a revoked key while retaining the previous key privately. Existing keys are never automatically revoked.

Configuration is local to the exact `--root`: `foundocs.json`, a marked `AGENTS.md` block, and either `.codex/config.toml` or `.mcp.json`. Claude additionally receives a marked `CLAUDE.md` reference to `AGENTS.md`. The package also installs its English Foundocs skill at `.agents/skills/foundocs/` for Codex or `.claude/skills/foundocs/` for Claude, including the Dreaming protocol reference. The managed instruction block points to the selected client’s discoverable skill. Existing instructions and foreign MCP entries are preserved. Skill files are updated only when unchanged from the installer’s recorded version. Byte-identical packaged files in a new clone are adopted locally; other foreign or user-edited skills stop preflight, and rollback preserves later user edits. Run `update-skills` to add the bundled skills to an older installation without a new connection code. Manual knowledge archival/restoration uses the server-discovered `set_knowledge_status` tool on explicit request; the bundled Foundocs skill documents versioned writes, archived lookup and the separate Dreaming approval path. Existing installations receive this guidance through `update-skills`; ordinary capture does not authorize archival. The bridge discovers tools dynamically, so server tool additions do not require a runtime upgrade. Dreaming itself requires the connected server to expose `dream_memory` and `get_dream`; installation does not enable unavailable server capabilities. Conflicting project IDs, malformed files, symlinks, or a different same-name `foundocs` server stop installation before exchanging the code. Resolve a conflict explicitly; this installer does not overwrite it.

Keys, backups and installation journals live in `~/.local/share/foundocs/setup`, outside the project. `FOUNDOCS_SETUP_HOME` may select another absolute private directory outside the target project, including isolated test fixtures. Keep using that same value for doctor/rollback. Credentials are isolated by workspace, project, and canonical project root. Both clients use the exact-version npm package’s `mcp` command through `npx` on PATH; their project settings contain no user-specific path. Older copied helpers remain in private storage for compatibility and rollback, but portable MCP does not depend on them. Its stdio adapter forwards MCP tool discovery and calls to the same Remote HTTP endpoint with the saved Bearer key. This adapter preserves remote schemas, annotations, structured results and errors, and requires an explicit valid project ID on every call. A changed valid project ID is forwarded unchanged; the remote server enforces workspace access. It adds no remote service. macOS/Linux use user-only directories/files (0700/0600). Windows uses PowerShell to apply and verify a protected current-user-only ACL; unsupported ACL filesystems stop before code exchange.

The helper prefers the saved installation credential. To explicitly use a process-provided `FOUNDOCS_API_KEY`, also provide matching `FOUNDOCS_PROJECT_ID` and `FOUNDOCS_WORKSPACE_ID`. An unrelated shell key never silently overrides the saved workspace key. The legacy HTTP helper’s stdout contains authentication headers solely for the host MCP client; do not invoke it through tools that log stdout. The shared portable runtime writes only MCP messages to stdout.

Version 0.2.0 recognizes recorded 0.1.x installations in their original private location. Reinstalling migrates their project filename, managed instruction markers and selected client's server name while retaining credential paths and the rollback journal. Existing doctor and rollback commands can discover the old location. Two recorded default locations are treated as a conflict; choose the intended location explicitly with `FOUNDOCS_SETUP_HOME`. A historical custom storage override remains supported when no current override is supplied. Credentials and helper directories are never moved automatically.

Migration refuses differing project IDs, foreign or duplicate server entries, malformed/mixed instruction markers and unsafe files before exchanging a code. It writes the new project configuration before replacing managed instructions and removes the old filename last. Every file write is atomic and journaled; the multi-file operation is recoverable rather than transactional. A retry reuses the same saved key. Rollback preserves the original installation baseline if an older journal exists; otherwise it restores the files as they were before migration. Manually changed or inline historical TOML server definitions require explicit conflict resolution. The private compatibility module also accepts a complete, matching historical credential namespace, only when no current credential variable is present.

Doctor performs MCP initialize, tool discovery, and `get_project_context` with the exact project ID. `diagnostic_passed` means the independent diagnostic succeeded. You must still trust/reconnect the project in the selected host and call its MCP tool to verify that host. Setup never reports host connection from file creation alone.

For response loss or failure before private key storage, the error reports the attempt ID and guide recovery route: inspect/revoke only that attempt's issued key and generate a new code. After key storage, rerun the same installation input. `rollback` restores only files still matching the installer-written content; concurrent edits are retained and reported. It preserves private credentials for retry. A stale operation lock after process interruption is never automatically deleted: confirm no installer is running before removing the reported private lock file.

## Shared Codex projects

Commit `foundocs.json`, the project `.codex/config.toml`, and the managed instructions/skills when the team shares them. A newly generated entry uses this transport (the actual file also lists supported environment variable **names**, never their values):

```toml
[mcp_servers.foundocs]
command = "npx"
args = ["--yes", "@foundocs/foundocs-setup@0.3.5", "mcp", "--project-id", "YOUR-PROJECT-UUID"]
env_vars = ["FOUNDOCS_SETUP_HOME", "FOUNDOCS_API_KEY", "FOUNDOCS_PROJECT_ID", "FOUNDOCS_WORKSPACE_ID", "STEERDOCS_SETUP_HOME", "STEERDOCS_API_KEY", "STEERDOCS_PROJECT_ID", "STEERDOCS_WORKSPACE_ID"]
startup_timeout_sec = 60
```

Each teammate runs the integration prompt once for their own clone. This creates a local private manifest/key scoped to that canonical checkout; it retains the existing valid portable TOML byte for byte. Copying, moving or cloning a checkout does not transfer its authentication. A missing local installation returns a redacted error explaining how to install or diagnose it. No `.env` loader is needed, and the agent never reads the API key.

The host must have Node.js 22.19.0+ and npm/npx on its PATH. A desktop launched without your shell's PATH may need its environment configured or a restart. The first uncached `npx` launch requires npm registry access; later launches use npm's normal cache. The runtime version is pinned to an exact release for reproducibility. Reinstalling/authenticating with a newer installer preserves an existing valid pin; `update-skills` never upgrades the MCP runtime. An intentional runtime update is a reviewed change to the shared pin, followed by local install/migrate and host verification. A pinned registry command requires that release to have been published; local pre-release verification uses a packed artifact installed in an isolated fixture.

The runtime starts from the host's working directory and selects the nearest `foundocs.json`. It stops at a Git checkout boundary, a malformed nearer file or a project-ID mismatch. It never searches another checkout for a working credential. It validates the canonical root, project/workspace IDs, endpoint, recorded attempt, expected private credential path and file permissions before opening the remote connection. The explicit `--project-id` protects a nested project from silently inheriting its parent's transport. These are startup identity checks: tool calls still pass their explicit `project_id` unchanged and the remote server retains its existing workspace authorization rules.

`FOUNDOCS_SETUP_HOME` selects custom private storage through the host environment. Keep the same value when installing, starting Codex, diagnosing, migrating and rolling back. Supported scoped API-key override names and historical equivalents are forwarded through `env_vars`; values stay outside Git. Per-server `cwd`, `env` and URL overrides are rejected by setup/doctor because they can silently change installation selection. Tool allowlists and timeouts are preserved.

### Existing Codex installations

After this release is published:

```text
npx --yes @foundocs/foundocs-setup@0.3.5 migrate --root /absolute/project
npx --yes @foundocs/foundocs-setup@0.3.5 doctor --root /absolute/project
```

`migrate` is offline, requires no connection code, and retains the credential bytes. It verifies the private manifest and journal against the original absolute transport, edits only the owned server's transport fields and preserves unrelated TOML, comments, tool settings and timeouts. Missing ownership evidence, changed execution settings and unsupported inline tables stop with the original file intact. An install rerun can perform the same migration while reusing its saved same-attempt key. `update-skills` remains skill-only.

Writes use the existing lock, atomic replacement, concurrency check and rollback journal. If interrupted, retain the journal and rerun the same command; confirm no process is running before clearing a stale lock. `rollback` restores unchanged setup edits to the recorded baseline and preserves later user edits and credentials. The baseline may predate migration when an installation already has a journal. After migration, restart/reconnect the trusted Codex project and call `get_project_context` through its MCP server. Doctor reports legacy transport migration separately from conflicting portable configuration; an independent doctor call does not prove the host connected.

## Shared Claude Code projects (0.3.5)

Commit the project `.mcp.json` alongside `foundocs.json`, instructions and `.claude/skills` when sharing a Claude project. A fresh Claude installation generates:

```json
{
  "mcpServers": {
    "foundocs": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@foundocs/foundocs-setup@0.3.5", "mcp", "--project-id", "YOUR-PROJECT-UUID"]
    }
  }
}
```

Every teammate runs the integration prompt once in their clone to save their own installation key. The shared JSON remains byte-identical when it already has a valid supported pin. Claude’s stdio process inherits the host environment: start Claude with Node/npm/npx on PATH and, when applicable, the same `FOUNDOCS_SETUP_HOME` and matching scoped credential override variables. No private environment value belongs in `.mcp.json`. The first uncached launch can require registry access. Approve the project MCP server in Claude before connecting.

Claude uses the same working-directory resolution, project ID guard, private manifest/credential checks and redacted errors as Codex. `CLAUDE_PROJECT_DIR` does not override root selection. Runtime 0.3.5 is the first version that accepts Claude installation manifests; a Claude pin to 0.3.4 is rejected. Existing Codex 0.3.4 pins remain supported and are not upgraded by reinstall or `update-skills`.

For an existing Claude HTTP `headersHelper` installation, run the same `migrate --root /absolute/project` command above with 0.3.5. Migration verifies the recorded helper command, private credential scope and endpoint before converting it to stdio. It performs no key exchange or remote request, retains unrelated JSON values and server settings, and supports retry and rollback. Modified endpoints/helpers, extra authentication or execution overrides, and missing ownership evidence are conflicts. JSON whitespace may be normalized during conversion; an already-portable configuration is left byte for byte unchanged. `doctor` points owned HTTP installs to migration, distinguishes configuration conflicts, and independently checks MCP connectivity. `update-skills` changes neither connection settings nor keys.

Before release, the 0.3.5 tarball was tested through both clients’ private installation records and real HTTP MCP. The macOS Claude CLI loaded the generated `.mcp.json` at project scope and reported Connected; a protocol client using the same generated command completed discovery and `get_project_context`. The real Codex host also discovered the tools and completed a read call. Claude was not logged in, so model-driven Claude tool selection was not verified. Public npm publication and Linux/Windows host verification are separate release checks.

## Verification status

The implementation includes unit/integration tests for both configuration formats, preservation, reruns, conflicts, credential isolation, redaction, recovery, rollback, protocol diagnostics, path quoting and ACL command generation. Local feature checks pass on macOS with Codex CLI 0.149.1 and Claude Code 2.1.284. Windows/Linux command paths are implemented, but real runtime verification on those operating systems is still required before claiming them verified. Package automated tests use isolated host capability fixtures. The 0.3.4 packed artifact was additionally verified in the product repository on macOS with a real Codex host, an isolated trusted CODEX_HOME, the generated project configuration, and an actual HTTP MCP get_project_context call. This does not verify Linux/Windows or a public npm release.

Development: `npm ci`, `npm test`, and `npm run typecheck`.


## Knowledge skills (0.3.1)

The 0.3.1 source includes the English `foundocs-capture-knowledge` skill and writing guide, plus the `foundocs` Dreaming skill and protocol reference. `install` copies the same bundle into `.agents/skills/` for Codex or `.claude/skills/` for Claude Code, and adds the exact skill link plus document/knowledge policy to its managed AGENTS block. Claude also receives the existing CLAUDE reference. Explicit user destinations and repository spec conventions take precedence over default Foundocs storage.

Existing recorded installations can update the skill and managed instructions without supplying a connection code, contacting the service or rotating credentials:

```text
node /absolute/path/to/foundocs-setup/src/cli.mjs update-skills --root /absolute/project
```

The equivalent command for this release is `npx --yes @foundocs/foundocs-setup@0.3.5 update-skills --root /absolute/project`. The local commands above run this checkout; a pinned npm command requires that registry release to exist.

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
