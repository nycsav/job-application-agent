export function routeSubmission(role, score, policy) {
  const source = lower(role.source);
  const platform = lower(role.platform);
  const title = lower(role.title);
  const isDream = score >= policy.thresholds.dream || /\b(director|vp|head|chief)\b/.test(title) && score >= policy.thresholds.materials;

  if (isDream) {
    return {
      route: 'bespoke_direct_ats',
      requiresHumanApproval: true,
      reason: 'Dream/high-fit role gets bespoke materials and direct review before apply.'
    };
  }

  if (policy.submission.apply4MeSources.some((item) => source.includes(item) || platform.includes(item))) {
    return {
      route: 'apply4me',
      requiresHumanApproval: true,
      reason: 'Volume-suitable role can route through Ladders Apply4Me/Magic Extension after approval.'
    };
  }

  if (policy.submission.directAtsPlatforms.includes(platform)) {
    return {
      route: 'direct_ats_stage',
      requiresHumanApproval: true,
      reason: `${role.platform} can usually be staged with browser automation.`
    };
  }

  return {
    route: 'manual_assist',
    requiresHumanApproval: true,
    reason: 'Unknown or high-friction platform should be handled as manual assist.'
  };
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
