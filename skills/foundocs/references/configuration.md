# Resolve the project configuration

Before the first Foundocs MCP call in each task, identify the absolute pathname of the governing AGENTS.md from its instruction header, or read that AGENTS.md if the client does not provide its location. Use the configuration filename declared there; new installations use foundocs.json in that AGENTS.md directory. Honor explicitly declared legacy filenames. Resolve ONE absolute configuration pathname internally before reading it, including when working from nested directories. Omit routine configuration-file and pathname announcements unless the user asks or they explain a configuration problem.

Read that exact file and validate a JSON object with a UUID project_id. Pass that project_id explicitly to every Foundocs MCP call. Keep the same absolute configuration pathname throughout the task and re-read it after configuration changes. An API key authenticates a workspace; it does not select a default project.

If that exact file is missing, malformed, or lacks a valid project_id, stop all Foundocs calls and ask for corrected configuration. A failed read does not change which AGENTS.md governs the task: never reinterpret the root, search for another configuration file, or try a relative-path or shell fallback. If the project is inaccessible, stop and ask; never guess another project. A client without local file access must ask the user for an explicit project_id.

Use the existing MCP connection and private authentication helper. FOUNDOCS_API_KEY is a supported scoped process-environment alternative. Never read, print, commit or copy credentials into reports, memories, prompts, AGENTS.md or the project configuration.

## Tool response errors

`OUTPUT_VALIDATION_ERROR` means a tool response does not match its advertised output schema; `INVALID_REMOTE_RESPONSE` means the MCP result is malformed. Check the server tool contract and runtime version. These errors do not establish an authentication failure: do not rotate keys, switch projects or repeat unchanged requests as a remedy. Another read tool in the same configured project may still work. Authentication (`UNAUTHENTICATED`), authorization (`FORBIDDEN`) and project-configuration errors still follow the stop rules above. Never bypass a denial with another tool or key.

The bridge reports safe error categories and tool names without forwarding raw response bodies, credentials or provider error data. A failed write response can follow a successful mutation; any identical retry must preserve the original requestId and input.
