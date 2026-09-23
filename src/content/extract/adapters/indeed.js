// Indeed. Uses data-testid attributes, which have been the most stable hooks
// across Indeed's redesigns. Indeed also emits JobPosting JSON-LD on most
// detail pages, so this is usually the fallback path.

import { firstText, companyLinkText } from './shared.js';

export const id = 'indeed';

export function match(url) {
  return /(^|\.)indeed\.com(\.\w+)?$/.test(location.hostname) && /(viewjob|jobs|rc\/clk|m\/jobs)/.test(url.pathname);
}

export function extract(doc = document) {
  let name = firstText(doc, [
    '[data-testid="inlineHeader-companyName"]',
    '[data-testid="company-name"]',
    '[data-company-name="true"]',
    '[data-testid="jobsearch-CompanyInfoContainer"] a',
    '.jobsearch-InlineCompanyRating a',
    '.jobsearch-CompanyInfoWithoutHeaderImage a',
    '#companyName',
  ], { max: 80 });

  if (!name) {
    // Indeed links to /cmp/<slug> for the employer.
    const a = doc.querySelector('a[href*="/cmp/"]');
    name = (a?.textContent || '').replace(/\s+/g, ' ').trim() || companyLinkText(doc)?.name || null;
  }

  const jobTitle = firstText(doc, [
    '[data-testid="jobsearch-JobInfoHeader-title"]',
    '.jobsearch-JobInfoHeader-title',
    'h1.jobsearch-JobInfoHeader-title',
    'h1',
  ], { max: 160 });

  const location = firstText(doc, [
    '[data-testid="inlineHeader-companyLocation"]',
    '[data-testid="job-location"]',
    '.jobsearch-JobInfoHeader-companyLocation',
  ], { max: 100 });

  return { name, jobTitle, location };
}
