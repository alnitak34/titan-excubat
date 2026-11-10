// Mirror the pinned SDK's selection, but never approve evidence or serialize env.
export function selectedComposeActions(deployment) {
  const actions = deployment.composeManager?.actions;
  if (!Array.isArray(actions)) return [];
  const selected = ['compose_up', 'compose_manager_started'].map(kind =>
    actions.findLast(a => a.action === kind)).filter(Boolean);
  return selected.map(a => ({
    action: a.action,
    commit: /^[a-f0-9]{40}$/i.test(a.commit ?? '') ? a.commit : undefined,
    file: typeof a.file === 'string' && /^[a-zA-Z0-9_./-]{1,200}$/.test(a.file) &&
      a.file.split('/').every(p => p !== '' && p !== '.' && p !== '..') ? a.file : undefined,
    fileSha256: /^[a-f0-9]{64}$/i.test(a.file_sha256 ?? '') ? a.file_sha256 : undefined,
    image: /^[a-zA-Z0-9_.:/@-]{1,250}$/.test(a.image ?? '') ? a.image : undefined,
    services: Array.isArray(a.services) ? a.services.slice(0, 32)
      .filter(s => typeof s === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(s)) : undefined,
    servicesTruncated: Array.isArray(a.services) && a.services.length > 32,
  }));
}
