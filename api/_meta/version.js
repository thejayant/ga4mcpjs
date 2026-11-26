// Meta Graph API version handling.
//
// Meta supports a Graph API version for about two years from release, then sunsets it.
// A hardcoded default therefore rots: it keeps working in a deployment that overrides it
// (production usually does) while silently breaking everywhere that does not -- exactly
// how the Google Ads v24 pin stayed invisible for months.
//
// So rather than carry a version number nobody revisits, this module knows the release
// dates it can vouch for, works out whether the configured version is past its supported
// window, and refuses to guess when it cannot tell.

export const META_SUPPORT_YEARS = 2;

/**
 * Release dates for the versions this code can vouch for. Deliberately NOT exhaustive:
 * a version that is not listed is reported as unknown rather than assumed current.
 */
export const META_VERSION_RELEASES = Object.freeze({
  "v18.0": "2023-09-12",
  "v19.0": "2024-01-23",
  "v20.0": "2024-05-21",
  "v21.0": "2024-10-02"
});

export const META_DEFAULT_VERSION = "v21.0";

export function metaGraphVersion() {
  return String(process.env.META_GRAPH_API_VERSION || META_DEFAULT_VERSION).trim();
}

function addYears(iso, years) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date;
}

/**
 * What is known about the configured version.
 * status is "supported", "past-sunset" or "unknown".
 */
export function metaVersionInfo(today = new Date()) {
  const version = metaGraphVersion();
  const configured = Boolean(String(process.env.META_GRAPH_API_VERSION || "").trim());
  const releasedOn = META_VERSION_RELEASES[version];

  if (!releasedOn) {
    return {
      version, configured, status: "unknown",
      note: `This build has no release date for Graph API ${version}, so its support window cannot be checked here. Confirm it against Meta's Graph API changelog.`
    };
  }

  const sunset = addYears(releasedOn, META_SUPPORT_YEARS);
  const estimatedSunset = sunset.toISOString().slice(0, 10);
  if (sunset > today) return { version, configured, releasedOn, estimatedSunset, status: "supported" };

  return {
    version, configured, releasedOn, estimatedSunset, status: "past-sunset",
    warning:
      `Graph API ${version} was released ${releasedOn} and Meta supports a version for about ${META_SUPPORT_YEARS} years, ` +
      `so it is past its estimated sunset of ${estimatedSunset}. ` +
      (configured
        ? "Set META_GRAPH_API_VERSION to a version Meta still supports."
        : "No META_GRAPH_API_VERSION is set, so this deployment is falling back to a version that is no longer supported. Set it to a current version.")
  };
}

/**
 * The base URL, refusing to call a version known to be past sunset when nothing was
 * configured. Failing here with an actionable message beats a confusing API error, and
 * beats silently carrying a stale default that only shows up in some environments.
 */
export function metaGraphBaseUrl() {
  const info = metaVersionInfo();
  if (info.status === "past-sunset" && !info.configured) {
    const error = new Error(
      `Meta Graph API version not configured. ${info.warning} Meta's Graph API changelog lists the current versions.`
    );
    error.code = "META_VERSION_UNSUPPORTED";
    throw error;
  }
  return `https://graph.facebook.com/${info.version}`;
}
