const DIMENSIONS = {
  agentic_architecture: [
    criterion('agentic systems', ['agentic', 'agents orchestrate agents', 'autonomous systems'], ['agentic', 'autonomous', 'multi-agent']),
    criterion('MCP tooling', ['mcp', 'model context protocol', 'mcp tool integration'], ['mcp', 'model context protocol']),
    criterion('orchestration', ['orchestration', 'agent workflows', 'workflows adapt'], ['orchestration', 'agent workflows', 'langgraph', 'crewai']),
    criterion('retrieval and context', ['retrieval', 'indexing', 'context engineering', 'context pipelines'], ['retrieval', 'rag', 'graphrag', 'context']),
    criterion('evaluation and governance', ['evaluation', 'guardrails', 'governance', 'observability'], ['evaluation', 'guardrails', 'governance', 'observability'])
  ],
  enterprise_transformation: [
    criterion('transformation', ['transformation', 'complex business challenges'], ['transformation', 'enterprise advisory']),
    criterion('pilot-to-production', ['production-ready', 'prototype to production', 'production-quality'], ['pilot-to-production', 'production']),
    criterion('operating model', ['execution models', 'delivery-ready implementation paths'], ['operating model', 'delivery model', 'managed services']),
    criterion('stakeholder alignment', ['stakeholders', 'executives', 'client teams'], ['stakeholder', 'c-suite', 'executive']),
    criterion('roadmaps and enablement', ['roadmap', 'enablement', 'workshops'], ['roadmap', 'enablement', 'workshop'])
  ],
  solution_principal: [
    criterion('technical direction', ['technical direction', 'design decisions', 'engineering standards'], ['technical direction', 'architecture', 'technical advisor', 'platform design']),
    criterion('solution architecture', ['solution architecture', 'solution patterns', 'platform patterns'], ['solution architecture', 'architect', 'reference architecture']),
    criterion('client partnership', ['client stakeholders', 'clients', 'client teams'], ['client stakeholders', 'clients', 'client', 'c-suite']),
    criterion('delivery leadership', ['implementation strategy', 'delivery', 'delivery risks'], ['implementation', 'delivery', 'pilot-to-production']),
    criterion('product and engineering alignment', ['product owners', 'architects', 'engineering teams'], ['product', 'engineering', 'cross-functional'])
  ],
  hands_on_builder: [
    criterion('Python and JavaScript', ['python', 'typescript', 'javascript', 'node.js'], ['python', 'typescript', 'javascript', 'node.js']),
    criterion('APIs and service contracts', ['rest/openapi', 'openapi', 'service contracts', 'api'], ['api', 'openapi', 'service contracts']),
    criterion('cloud deployment', ['cloud-native', 'deployment', 'ci/cd'], ['cloud', 'aws', 'azure', 'gcp', 'deployment', 'ci/cd']),
    criterion('production delivery', ['production', 'automated testing', 'observability'], ['production', 'testing', 'observability']),
    criterion('hands-on build', ['hands-on', 'building', 'tooling'], ['hands-on', 'build', 'built', 'coded', 'deployed'])
  ],
  domain_fit: [
    criterion('financial services', ['financial services', 'finance'], ['financial services', 'finance', 'financial']),
    criterion('health and life sciences', ['healthcare', 'life sciences'], ['healthcare', 'life sciences', 'pharma']),
    criterion('enterprise technology', ['high tech', 'technology', 'enterprise'], ['technology', 'enterprise', 'fortune 500']),
    criterion('manufacturing and industrial', ['manufacturing', 'energy'], ['manufacturing', 'industrial', 'energy'])
  ],
  gtm_partnerships: [
    criterion('thought leadership', ['thought leadership', 'papers', 'conference talks'], ['thought leadership', 'conference', 'speaker']),
    criterion('client narratives', ['solution narratives', 'client-facing'], ['narrative', 'client-facing', 'positioning']),
    criterion('partnership', ['partnership', 'partnering'], ['partnership', 'partner']),
    criterion('go-to-market', ['go-to-market', 'gtm'], ['go-to-market', 'gtm'])
  ]
};

const GAP_SIGNALS = [
  criterion('React / Node.js', ['react', 'node.js'], ['react', 'node.js']),
  criterion('CI/CD', ['ci/cd'], ['ci/cd']),
  criterion('observability', ['observability'], ['observability']),
  criterion('automated testing', ['automated testing'], ['automated testing', 'testing']),
  criterion('microservices / C4', ['microservices', 'c4 modeling'], ['microservices', 'c4']),
  criterion('computer science degree', ['computer science degree required', 'engineering degree required'], ['computer science', 'engineering degree'])
];

export function compareResumeTexts(job, resumes) {
  const jobText = normalize(`${job.title || ''} ${job.company || ''} ${job.description || ''} ${job.requirements || ''}`);
  const jobTerms = termSet(jobText);

  return resumes.map((resume) => {
    const resumeText = normalize(resume.text);
    const resumeTerms = termSet(resumeText);
    const dimensionScores = {};
    let dimensionTotal = 0;

    for (const [dimension, phrases] of Object.entries(DIMENSIONS)) {
      const jobHits = phrases.filter((item) => hasAny(jobText, item.job)).map((item) => item.label);
      if (!jobHits.length) {
        dimensionScores[dimension] = { score: 0, jobHits, resumeHits: [] };
        continue;
      }
      const resumeHits = phrases
        .filter((item) => hasAny(jobText, item.job) && hasAny(resumeText, item.resume))
        .map((item) => item.label);
      const score = resumeHits.length / jobHits.length;
      dimensionScores[dimension] = { score, jobHits, resumeHits };
      dimensionTotal += score;
    }

    const keywordOverlap = [...jobTerms].filter((term) => resumeTerms.has(term));
    const jdSignalCount = Object.values(dimensionScores).filter((d) => d.jobHits.length > 0).length || 1;
    const phraseScore = dimensionTotal / jdSignalCount;
    const keywordScore = Math.min(keywordOverlap.length / 45, 1);
    const profileHits = (resume.profileTerms || []).filter((term) => jobText.includes(term));
    const profileScore = resume.profileTerms?.length ? Math.min(profileHits.length / 3, 1) : phraseScore;
    const riskMatches = GAP_SIGNALS
      .filter((item) => hasAny(jobText, item.job) && !hasAny(resumeText, item.resume))
      .map((item) => item.label);
    const score = Math.round((phraseScore * 0.62 + keywordScore * 0.18 + profileScore * 0.2) * 100);

    return {
      id: resume.id,
      file: resume.file,
      label: resume.label,
      score,
      keywordOverlap: keywordOverlap.slice(0, 30),
      profileHits,
      dimensionScores,
      riskMatches,
      rationale: buildRationale(resume, score, dimensionScores, riskMatches)
    };
  }).sort((a, b) => b.score - a.score);
}

function criterion(label, job, resume = job) {
  return { label, job, resume };
}

function hasAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function buildRationale(resume, score, dimensionScores, riskMatches) {
  const strengths = Object.entries(dimensionScores)
    .filter(([, value]) => value.resumeHits.length > 0)
    .map(([key, value]) => `${key}: ${value.resumeHits.join(', ')}`);
  const gaps = riskMatches.length ? `Tailoring gaps: ${riskMatches.join(', ')}` : 'No major tailoring gaps detected.';
  return `${resume.label} scores ${score}/100. ${strengths.join(' | ') || 'Limited direct phrase match.'} ${gaps}`;
}

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9+#.\/$ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function termSet(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'are', 'our', 'your', 'will', 'into', 'across', 'within', 'role']);
  return new Set(
    text.split(/\s+/)
      .map((term) => term.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
      .filter((term) => term.length > 3 && !stop.has(term))
  );
}
