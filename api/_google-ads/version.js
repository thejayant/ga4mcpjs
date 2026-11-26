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

// Sunset month per major version, from Google's deprecation and sunset timetable.
// The running version is not always the pinned one (GOOGLE_ADS_API_VERSION can override
// it), so the sunset has to be looked up for whichever version is actually in use --
// reporting the pinned version's sunset for a different version is how a deadline gets
// missed.
export const GOOGLE_ADS_API_SUNSETS = Object.freeze({
  v23: "2027-02",
  v24: "2027-05",
  v25: "2027-08",
  v26: "2027-11"
});

export const GOOGLE_ADS_API_SUNSET = GOOGLE_ADS_API_SUNSETS[GOOGLE_ADS_API_VERSION];

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

/**
 * Attached to every normalized Ads error so a version bump is obvious in logs (item 21).
 *
 * `sunsets` tracks the version actually being called, not the pinned one. When
 * GOOGLE_ADS_API_VERSION pins an older version than the code targets, that is surfaced
 * explicitly: otherwise the upgrade looks done in the source while the live calls are
 * still on the old version.
 */
export function googleAdsVersionInfo() {
  const inUse = googleAdsApiVersion();
  const overridden = inUse !== GOOGLE_ADS_API_VERSION;
  return {
    apiVersion: inUse,
    writtenAgainst: GOOGLE_ADS_API_RELEASE,
    sunsets: GOOGLE_ADS_API_SUNSETS[inUse] || "unknown",
    ...(overridden
      ? {
          pinnedVersion: GOOGLE_ADS_API_VERSION,
          versionWarning:
            `Live calls use ${inUse} because the GOOGLE_ADS_API_VERSION environment variable overrides the pinned ${GOOGLE_ADS_API_VERSION}. ` +
            `${inUse} sunsets ${GOOGLE_ADS_API_SUNSETS[inUse] || "on an unknown date"}, and features added after it are unavailable. ` +
            `Remove that variable (or set it to ${GOOGLE_ADS_API_VERSION}) to use the version this code targets.`
        }
      : {})
  };
}
