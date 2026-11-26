// The one place the Google Ads API version is pinned (item 21).
//
// Bumping a version is a one-line change here. Minor versions inside a major are
// drop-in, so v26.2 is served by the v26 REST prefix.
//
// Release / sunset dates (verified against Google's release notes and sunset table
// on 2026-11-26):
//   v24  released 2026-04-22, sunsets May 2027
//   v25  released 2026-07-22, sunsets August 2027
//   v26  released 2026-10-14, sunsets November 2027   <- current
//   v26.2 (2026-11-11) is the newest release; it is served by the v26 prefix.
export const GOOGLE_ADS_API_VERSION = "v26";

// The newest minor release this code was written against, for error reports only.
export const GOOGLE_ADS_API_RELEASE = "v26.2";

export const GOOGLE_ADS_API_SUNSET = "2027-11";

export const GOOGLE_ADS_API_BASE = "https://googleads.googleapis.com";

// GOOGLE_ADS_API_VERSION may override the pin for an emergency roll-forward, but only
// to another vNN prefix; anything else is ignored so a typo cannot take the Ads layer down.
export function googleAdsApiVersion() {
  const override = String(process.env.GOOGLE_ADS_API_VERSION || "").trim();
  return /^v\d+$/.test(override) ? override : GOOGLE_ADS_API_VERSION;
}

export function googleAdsApiUrl(path) {
  if (String(path).startsWith("http")) return String(path);
  return `${GOOGLE_ADS_API_BASE}/${googleAdsApiVersion()}/${String(path).replace(/^\/+/, "")}`;
}

// Attached to every normalized Ads error so a version bump is obvious in logs (item 21).
export function googleAdsVersionInfo() {
  return { apiVersion: googleAdsApiVersion(), writtenAgainst: GOOGLE_ADS_API_RELEASE, sunsets: GOOGLE_ADS_API_SUNSET };
}
