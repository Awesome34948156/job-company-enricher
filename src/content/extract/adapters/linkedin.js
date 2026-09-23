// LinkedIn Jobs.
//
// LinkedIn hashes its CSS class names (css-1abc2de) and rotates them, so those
// are never used here. Preference order: stable data-test-id attributes, the
// company-profile link slug, then the (older but long-lived) BEM class names.
// In practice JSON-LD wins on /jobs/view/ pages and this is the fallback.

import { firstText, companyLinkText, nameFromCompanySlug } from './shared.js';

export const id = 'linkedin';

export function match(url) {
  return /(^|\.)linkedin\.com$/.test(location.hostname) && /\/jobs/.test(url.pathname);
}

export function extract(doc = document) {
  let name = firstText(doc, [
    '[data-test-id="job-posting-company-name"]',
    '[data-test-id*="company-name"]',
    '[data-testid*="company-name"]',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
    '.topcard__org-name-link',
    '.job-details-jobs-unified-top-card__primary-description a',
  ], { max: 80 });

  if (!name) {
    const link = companyLinkText(doc);
    name = link?.name || null;
  }

  // Last LinkedIn-specific resort: an anchor pointing at /company/<slug>.
  if (!name) {
    const a = doc.querySelector('a[href*="/company/"]');
    name = nameFromCompanySlug(a?.getAttribute('href'));
  }

  const jobTitle = firstText(doc, [
    '[data-test-id="job-details-jobs-unified-top-card__job-title"]',
    '[data-testid="jobsearch-JobInfoHeader-title"]',
    '.job-details-jobs-unified-top-card__job-title',
    '.topcard__title',
    'h1',
  ], { max: 160 });

  const location = firstText(doc, [
    '[data-test-id="job-details-jobs-unified-top-card__primary-description"]',
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.topcard__flavor--bullet',
  ], { max: 100 });

  return { name, jobTitle, location };
}
