/**
 * Browser crawler seam.
 *
 * The production version will use the Browser plugin / Playwright against
 * authenticated LinkedIn, Indeed, Ladders, and company-career sessions.
 * This module deliberately emits normalized raw roles and never submits.
 */

export async function crawlSavedJobs() {
  return {
    roles: [],
    blocked: [],
    notes: [
      'Browser crawler not connected yet.',
      'Next step: implement platform crawlers that collect saved jobs and full JD text.'
    ]
  };
}
