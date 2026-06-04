export function evaluateHardFilters(role, policy) {
  const reasons = [];
  const filters = policy.hardFilters;
  const company = lower(role.company);
  const title = lower(role.title);
  const jd = lower(`${role.description || ''} ${role.requirements || ''}`);

  const excluded = filters.excludedCompanies.find((name) => company.includes(lower(name)));
  if (excluded) reasons.push(`excluded company: ${excluded}`);

  const loc = lower(role.location);
  const acceptedLocation = !loc || role.isRemote || filters.acceptedLocations.some((x) => loc.includes(x));
  if (!acceptedLocation) reasons.push(`location not accepted: ${role.location}`);

  if (isContractRole(role)) {
    const hourly = parseHourlyCeiling(role.salary);
    if (hourly != null && hourly < filters.contractHourlyFloor) {
      reasons.push(`hourly ceiling $${hourly}/hr below $${filters.contractHourlyFloor}/hr`);
    }
  } else {
    const salary = parseSalaryCeiling(role.salary);
    if (salary != null && salary < filters.fteSalaryFloor) {
      reasons.push(`salary ceiling $${salary.toLocaleString()} below $${filters.fteSalaryFloor.toLocaleString()}`);
    }
  }

  if (requiresDisallowedDegree(jd, filters.skipIfRequiresDegree)) {
    reasons.push('requires CS/engineering degree');
  }

  if (filters.skipHandsOnICEngineer && isHandsOnICEngineer(title, jd)) {
    reasons.push('hands-on IC engineering role');
  }

  return {
    pass: reasons.length === 0,
    reasons
  };
}

export function parseSalaryCeiling(raw) {
  if (raw == null || raw === '') return null;
  const s = lower(raw);
  if (/depends on experience|compensation information|not posted|not listed/.test(s)) return null;
  const matches = [...s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([km])?/g)];
  const nums = matches.map((m) => {
    let n = Number(m[1].replace(/,/g, ''));
    if (!n) return 0;
    if (m[2] === 'k') n *= 1000;
    if (m[2] === 'm') n *= 1000000;
    return n;
  }).filter(Boolean);
  if (!nums.length) return null;
  let max = Math.max(...nums);
  const hourly = /per hour|\/hr|\bhour\b/.test(s) || (max > 20 && max < 1000 && !/[km]\b/.test(s));
  if (hourly && max < 1000) max *= 2080;
  return Math.round(max);
}

export function parseHourlyCeiling(raw) {
  if (raw == null || raw === '') return null;
  const s = lower(raw);
  const matches = [...s.matchAll(/\$?\s*(\d{2,3}(?:\.\d+)?)(?=\s*(?:\/hr|per hour|hour|\-|to|$))/g)];
  const nums = matches.map((m) => Number(m[1])).filter((n) => n > 0 && n < 1000);
  return nums.length ? Math.max(...nums) : null;
}

function isContractRole(role) {
  return /contract|consult|fractional|interim|1099|w2|hourly|\/hr|per hour/.test(
    lower(`${role.title || ''} ${role.salary || ''} ${role.employmentType || ''}`)
  );
}

function requiresDisallowedDegree(jd, terms) {
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nearRequired = new RegExp(`(required|must|mandatory).{0,80}${escaped}|${escaped}.{0,80}(required|must|mandatory)`, 'i');
    return nearRequired.test(jd);
  });
}

function isHandsOnICEngineer(title, jd) {
  const leadership = /\b(vp|vice president|head of|director|chief|senior director|lead)\b/i.test(title);
  const engineer = /\b(engineer|developer|swe)\b/i.test(title);
  const handsOn = /(hands-on coding|write production code|python|typescript|golang|kubernetes|terraform|microservices|ship production code)/i.test(jd);
  return engineer && !leadership && handsOn;
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
