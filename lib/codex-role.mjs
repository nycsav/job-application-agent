import crypto from 'node:crypto';

export function normalizeRole(raw = {}, source = raw.source || 'manual') {
  const title = clean(raw.title);
  const company = clean(raw.company || raw.companyName);
  const location = clean(raw.location || raw.jobLocation?.displayName);
  const description = clean(raw.description || raw.summary || raw.snippet);
  const requirements = clean(raw.requirements);
  const url = clean(raw.url || raw.apply_url || raw.detailsPageUrl);
  const salary = raw.salary == null ? null : clean(String(raw.salary));
  const platform = clean(raw.platform || inferPlatform(url));
  const idSeed = [company, title, url || source].join('|').toLowerCase();

  return {
    id: raw.id || hash(idSeed),
    source,
    title,
    company,
    location,
    salary,
    description,
    requirements,
    url,
    apply_url: url,
    platform,
    isRemote: Boolean(raw.isRemote) || /remote/i.test(location),
    discoveredAt: raw.discoveredAt || new Date().toISOString()
  };
}

export function roleKey(role) {
  return `${role.company || ''}|${role.title || ''}`.toLowerCase().trim();
}

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function inferPlatform(url = '') {
  const u = String(url).toLowerCase();
  if (u.includes('greenhouse')) return 'greenhouse';
  if (u.includes('lever.co')) return 'lever';
  if (u.includes('ashbyhq')) return 'ashby';
  if (u.includes('workday')) return 'workday';
  if (u.includes('oraclecloud')) return 'oracle';
  if (u.includes('icims')) return 'icims';
  if (u.includes('linkedin')) return 'linkedin';
  if (u.includes('indeed')) return 'indeed';
  if (u.includes('theladders') || u.includes('ladders')) return 'ladders';
  return 'unknown';
}
