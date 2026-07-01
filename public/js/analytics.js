// ---------------------------------------------------------------------------
// Google Analytics 4 — visitors, sessions, engagement time, plus custom game
// events (how long each battle lasted, which scale, kills).
//
// TO TURN IT ON: set GA_ID below to YOUR Measurement ID from
//   analytics.google.com  →  Admin  →  Data streams  →  Web  →  (your stream)
// It looks like  G-XXXXXXXXXX. While it's the placeholder, analytics is OFF —
// no script loads and no cookies are set, so this is safe to ship as-is.
// ---------------------------------------------------------------------------
const GA_ID = 'G-76QKHST1ME';

const enabled = /^G-[A-Z0-9]{6,}$/.test(GA_ID) && GA_ID !== 'G-XXXXXXXXXX';

if (enabled) {
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { anonymize_ip: true });
}

// Fire a custom event (no-op until GA_ID is set). GA4 shows these under
// Reports → Engagement → Events, with your params as event parameters.
export function track(name, params = {}) {
  if (enabled && window.gtag) window.gtag('event', name, params);
}

export const analyticsEnabled = enabled;
