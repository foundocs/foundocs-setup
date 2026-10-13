// Historical identifiers are read only for compatibility with installed 0.1.x clients.
// New installations always use the current Foundocs names.
export const legacy = Object.freeze({
  name: 'steerdocs', config: 'steerdocs.json', homeEnv: 'STEERDOCS_SETUP_HOME',
  start: '<!-- steerdocs:setup:start -->', end: '<!-- steerdocs:setup:end -->',
  keyEnv: 'STEERDOCS_API_KEY', projectEnv: 'STEERDOCS_PROJECT_ID', workspaceEnv: 'STEERDOCS_WORKSPACE_ID',
});

export function legacyCredential(env, projectId, workspaceId) {
  return env[legacy.projectEnv] === projectId && env[legacy.workspaceEnv] === workspaceId
    ? env[legacy.keyEnv] : undefined;
}

export function legacyInstructions(text) {
  return text.replaceAll('foundocs.json', legacy.config).replaceAll('FOUNDOCS_API_KEY', legacy.keyEnv);
}
