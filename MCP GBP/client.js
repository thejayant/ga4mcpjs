export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

export const GBP_HOSTS = Object.freeze({
  accounts: "https://mybusinessaccountmanagement.googleapis.com/v1",
  information: "https://mybusinessbusinessinformation.googleapis.com/v1",
  performance: "https://businessprofileperformance.googleapis.com/v1",
  actions: "https://mybusinessplaceactions.googleapis.com/v1",
  lodging: "https://mybusinesslodging.googleapis.com/v1",
  legacy: "https://mybusiness.googleapis.com/v4"
});

export const GBP_DAILY_METRICS = Object.freeze([
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_MENU_CLICKS"
]);

export const GBP_LOCATION_READ_MASK = [
  "name", "title", "storeCode", "languageCode", "phoneNumbers", "categories",
  "storefrontAddress", "serviceArea", "websiteUri", "regularHours", "specialHours",
  "moreHours", "serviceItems", "profile", "openInfo", "metadata", "labels",
  "latlng", "relationshipData"
].join(",");

export function gbpId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Business Profile resource ID.");
  return id;
}

export function gbpPathId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.includes("/") || id.includes("?") || id.includes("#")) {
    throw new Error("Invalid Business Profile resource ID.");
  }
  return encodeURIComponent(id);
}

export function gbpDate(dateString, prefix) {
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? new Date(`${dateString}T00:00:00Z`) : null;
  if (!timestamp || Number.isNaN(timestamp.getTime()) || timestamp.toISOString().slice(0, 10) !== dateString) {
    throw new Error(`Invalid ${prefix} date. Use YYYY-MM-DD.`);
  }
  const [year, month, day] = dateString.split("-");
  return { [`${prefix}.year`]: Number(year), [`${prefix}.month`]: Number(month), [`${prefix}.day`]: Number(day) };
}

export async function gbpRequest(accessToken, family, path, { method = "GET", query, body } = {}) {
  const base = GBP_HOSTS[family];
  if (!base || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Business Profile API request.");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
  return { ok: response.ok, status: response.status, body: parsed };
}
