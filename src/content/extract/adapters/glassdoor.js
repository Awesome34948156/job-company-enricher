// Glassdoor job and company pages.
//
// Glassdoor uses data-test attributes. It also embeds an employerName in its
// client-side state blob; that's deliberately not parsed here — it's an
// undocumented internal shape that changes without notice, and the JSON-LD /
// DOM paths cover the same ground.

import { firstText, companyLinkText, nameFromCompanySlug } from './shared.js';

export const id = 'glassdoor';

export function match(url) {
  return /(^|\.)glassdoor\.(com|com\.hk|co\.uk|ca|com\.au|de|fr|sg)$/.test(location.hostname)
    && /(job-listing|Job|employer|Overview|jobs)/i.test(url.pathname);
}

export function extract(doc = document) {
  let name = firstText(doc, [
    '[data-test="employer-name"]',
    '[data-test="employerName"]',
    '[data-test="job-employer-name"]',
    '.employer-name',
    '#EmpBasicInfo [data-test="employerName"]',
  ], { max: 100 });

  if (!name) {
    const a = doc.querySelector('a[href*="/Overview/"], a[href*="/Working-at-"]');
    name = (a?.textContent || '').replace(/\s+/g, ' ').trim()
      || nameFromCompanySlug(a?.getAttribute('href'))
      || companyLinkText(doc)?.name
      || null;
  }

  // /Overview/Working-at-Acme-HK-Ltd-EI_IE123.htm → "Acme HK Ltd"
  if (!name) {
    const m = location.pathname.match(/Working-at-([^/]+?)(?:-EI_IE\d+)?\.htm/i);
    if (m) {
      name = m[1].split('-').filter(Boolean)
        .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ');
    }
  }

  const jobTitle = firstText(doc, [
    '[data-test="job-title"]',
    '[data-test="jobTitle"]',
    '.job-title',
    'h1',
  ], { max: 160 });

  const loc = firstText(doc, [
    '[data-test="location"]',
    '[data-test="job-location"]',
  ], { max: 100 });

  return { name, jobTitle, location: loc };
}
