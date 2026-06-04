const TITLE_STRONG = ['vp', 'vice president', 'head of', 'director', 'principal', 'chief'];
const TITLE_MEDIUM = ['senior manager', 'manager', 'lead', 'practice lead', 'solutions architect'];
const SKILLS = [
  'ai strategy',
  'agentic',
  'llm',
  'claude',
  'mcp',
  'rag',
  'enterprise ai',
  'pilot to production',
  'transformation',
  'c-suite',
  'consulting',
  'financial services'
];
const INDUSTRY = ['ai', 'technology', 'consulting', 'financial services', 'healthcare', 'pharma'];

export function scoreRole(role) {
  const title = lower(role.title);
  const body = lower(`${role.title || ''} ${role.description || ''} ${role.requirements || ''} ${role.company || ''}`);
  const location = lower(role.location);

  const breakdown = {
    title: TITLE_STRONG.some((x) => title.includes(x)) ? 3 : TITLE_MEDIUM.some((x) => title.includes(x)) ? 2 : 1,
    skills: 0,
    industry: 0,
    location: 0,
    compensation: 0
  };

  const matchedSkills = SKILLS.filter((skill) => body.includes(skill));
  if (matchedSkills.length >= 4) breakdown.skills = 3;
  else if (matchedSkills.length >= 2) breakdown.skills = 2;
  else if (matchedSkills.length >= 1) breakdown.skills = 1;

  const matchedIndustries = INDUSTRY.filter((item) => body.includes(item));
  breakdown.industry = matchedIndustries.length >= 2 ? 2 : matchedIndustries.length === 1 ? 1 : 0;
  breakdown.location = role.isRemote || /remote|hybrid|new york|nyc|united states/.test(location) ? 1 : 0;
  breakdown.compensation = role.salary ? 1 : breakdown.title >= 2 ? 1 : 0;

  const total = breakdown.title + breakdown.skills + breakdown.industry + breakdown.location + breakdown.compensation;
  const score = Math.round((total / 10) * 10);

  return {
    score,
    breakdown,
    matchedSkills,
    matchedIndustries
  };
}

export function bucketForScore(score, thresholds) {
  if (score >= thresholds.materials) return 'materials';
  if (score >= thresholds.priority) return 'priority';
  if (score >= thresholds.track) return 'track';
  return 'skip';
}

function lower(value = '') {
  return String(value || '').toLowerCase();
}
