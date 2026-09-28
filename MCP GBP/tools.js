import { z } from "zod";
import {
  GBP_SCOPE, GBP_DAILY_METRICS, GBP_LOCATION_READ_MASK,
  gbpDate, gbpId, gbpPathId, gbpRequest
} from "./client.js";

const id = z.string().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const json = z.record(z.any());
const paging = { pageSize: z.number().int().min(1).max(100).optional(), pageToken: z.string().optional() };
const locationRead = { locationId: id };
const legacyLocation = { accountId: id, locationId: id };
const accountPath = (p) => `/accounts/${gbpId(p.accountId)}`;
const locationPath = (p) => `/locations/${gbpId(p.locationId)}`;
const legacyPath = (p) => `/accounts/${gbpId(p.accountId)}/locations/${gbpId(p.locationId)}`;
const confirmed = { confirmed: z.literal(true) };

export const GBP_TOOL_NAMES = Object.freeze([
  "gbp_list_accounts", "gbp_get_account", "gbp_list_account_admins", "gbp_list_location_admins", "gbp_list_account_invitations",
  "gbp_list_locations", "gbp_get_location", "gbp_get_google_updated_location", "gbp_find_location_matches",
  "gbp_create_location", "gbp_update_location", "gbp_delete_location", "gbp_get_location_attributes", "gbp_get_google_updated_attributes", "gbp_update_location_attributes",
  "gbp_list_categories", "gbp_list_available_attributes", "gbp_search_chains", "gbp_search_google_locations", "gbp_associate_location", "gbp_report_google_location",
  "gbp_list_reviews", "gbp_get_review", "gbp_review_backlog", "gbp_publish_review_reply",
  "gbp_list_posts", "gbp_get_post", "gbp_create_post", "gbp_update_post", "gbp_delete_post", "gbp_get_post_insights",
  "gbp_list_media", "gbp_get_media", "gbp_create_media_from_url", "gbp_update_media", "gbp_delete_media", "gbp_list_customer_media",
  "gbp_get_daily_performance", "gbp_get_monthly_search_keywords",
  "gbp_list_action_links", "gbp_get_action_link", "gbp_list_action_types", "gbp_get_lodging", "gbp_get_service_list", "gbp_get_food_menus"
]);

export function registerGbpTools(server, { req, withVerifiedToolAuth, buildToolResult }) {
  const registered = [];
  function add(name, description, inputSchema, action, isWrite = false) {
    registered.push(name);
    server.registerTool(name, {
      title: name.replace(/^gbp_/, "GBP ").replace(/_/g, " "),
      description,
      inputSchema: isWrite ? { ...inputSchema, ...confirmed } : inputSchema,
      annotations: isWrite ? { readOnlyHint: false, destructiveHint: /delete|report/.test(name) } : { readOnlyHint: true }
    }, async (params) => withVerifiedToolAuth(req, [GBP_SCOPE], async ({ googleCredentials }) => {
      try {
        if (isWrite && params?.confirmed !== true) throw new Error("Explicit confirmed: true is required.");
        const response = await action(googleCredentials.accessToken, params || {});
        return buildToolResult(response.ok ? response.body : { status: response.status, error: response.body }, !response.ok);
      } catch (error) {
        return buildToolResult({ error: "gbp_request_failed", message: error instanceof Error ? error.message : String(error) }, true);
      }
    }));
  }
  const call = (token, family, path, options) => gbpRequest(token, family, path, options);

  add("gbp_list_accounts", "List GBP accounts accessible to the signed-in user.", paging,
    (t, p) => call(t, "accounts", "/accounts", { query: { pageSize: p.pageSize, pageToken: p.pageToken } }));
  add("gbp_get_account", "Get a GBP account and its access role.", { accountId: id },
    (t, p) => call(t, "accounts", accountPath(p)));
  add("gbp_list_account_admins", "Read account administrators and roles; cannot change access.", { accountId: id, ...paging },
    (t, p) => call(t, "accounts", `${accountPath(p)}/admins`, { query: { pageSize: p.pageSize, pageToken: p.pageToken } }));
  add("gbp_list_location_admins", "Read location administrators and roles; cannot change access.", locationRead,
    (t, p) => call(t, "accounts", `${locationPath(p)}/admins`));
  add("gbp_list_account_invitations", "Read pending account invitations; cannot accept or decline them.", { accountId: id },
    (t, p) => call(t, "accounts", `${accountPath(p)}/invitations`));

  add("gbp_list_locations", "List GBP locations with filters, order, pagination, and a field read mask.", {
    accountId: id, filter: z.string().optional(), orderBy: z.string().optional(), readMask: z.string().optional(), ...paging
  }, (t, p) => call(t, "information", `${accountPath(p)}/locations`, { query: {
    readMask: p.readMask || GBP_LOCATION_READ_MASK, filter: p.filter, orderBy: p.orderBy, pageSize: p.pageSize, pageToken: p.pageToken
  } }));
  add("gbp_get_location", "Get profile content and metadata for one location.", { ...locationRead, readMask: z.string().optional() },
    (t, p) => call(t, "information", locationPath(p), { query: { readMask: p.readMask || GBP_LOCATION_READ_MASK } }));
  add("gbp_get_google_updated_location", "Read Google's suggested changes for a location.", { ...locationRead, readMask: z.string().optional() },
    (t, p) => call(t, "information", `${locationPath(p)}:getGoogleUpdated`, { query: { readMask: p.readMask || GBP_LOCATION_READ_MASK } }));
  add("gbp_find_location_matches", "Find potential duplicate/matching Google listings for an unverified location.", {
    ...legacyLocation, languageCode: z.string().optional(), numResults: z.number().int().min(1).max(10).optional()
  }, (t, p) => call(t, "legacy", `${legacyPath(p)}:findMatches`, { method: "POST", body: { languageCode: p.languageCode, numResults: p.numResults } }));
  add("gbp_create_location", "Create a location in an account. Requires explicit confirmation.", { accountId: id, location: json },
    (t, p) => call(t, "information", `${accountPath(p)}/locations`, { method: "POST", body: p.location }), true);
  add("gbp_update_location", "Update selected location fields with a required field mask. Requires explicit confirmation.", {
    ...locationRead, location: json, updateMask: z.string().min(1), validateOnly: z.boolean().optional()
  }, (t, p) => {
    const fields = p.updateMask.split(",").map((field) => field.trim());
    if (fields.some((field) => !/^(title|storeCode|phoneNumbers|categories|storefrontAddress|serviceArea|websiteUri|regularHours|specialHours|moreHours|serviceItems|profile|openInfo|labels|relationshipData)(\.[A-Za-z]+)*$/.test(field))) {
      throw new Error("updateMask contains an unsupported or protected field.");
    }
    return call(t, "information", locationPath(p), { method: "PATCH", query: { updateMask: fields.join(","), validateOnly: p.validateOnly }, body: { ...p.location, name: locationPath(p).slice(1) } });
  }, true);
  add("gbp_delete_location", "Delete a location. Requires explicit confirmation.", locationRead,
    (t, p) => call(t, "information", locationPath(p), { method: "DELETE" }), true);
  add("gbp_get_location_attributes", "Read attributes set on a location.", locationRead,
    (t, p) => call(t, "information", `${locationPath(p)}/attributes`));
  add("gbp_get_google_updated_attributes", "Read Google's suggested attribute updates.", locationRead,
    (t, p) => call(t, "information", `${locationPath(p)}/attributes:getGoogleUpdated`));
  add("gbp_update_location_attributes", "Update selected location attributes. Requires explicit confirmation.", {
    ...locationRead, attributes: z.array(json), attributeMask: z.string().min(1)
  }, (t, p) => {
    const mask = p.attributeMask.split(",").map((item) => item.trim());
    if (mask.some((item) => !/^attributes\/[A-Za-z0-9_-]+$/.test(item))) throw new Error("attributeMask must list attributes/{attribute} names.");
    return call(t, "information", `${locationPath(p)}/attributes`, {
      method: "PATCH", query: { attributeMask: mask.join(",") }, body: { name: `${locationPath(p).slice(1)}/attributes`, attributes: p.attributes }
    });
  }, true);

  add("gbp_list_categories", "Discover valid GBP categories by country and language.", {
    regionCode: id, languageCode: id, view: z.enum(["BASIC", "FULL"]).default("FULL"), filter: z.string().optional(), ...paging
  }, (t, p) => call(t, "information", "/categories", { query: { ...p, view: p.view || "FULL" } }));
  add("gbp_list_available_attributes", "Discover available attributes for a primary category and country.", {
    categoryName: id, regionCode: id, languageCode: id, ...paging
  }, (t, p) => {
    const categoryId = p.categoryName.replace(/^categories\//, "");
    if (!/^[A-Za-z0-9_:-]+$/.test(categoryId)) throw new Error("Invalid Business Profile category ID.");
    return call(t, "information", "/attributes", { query: { ...p, categoryName: `categories/${categoryId}` } });
  });
  add("gbp_search_chains", "Search chain metadata by chain name.", { chainName: id, ...paging },
    (t, p) => call(t, "information", "/chains:search", { query: p }));
  add("gbp_search_google_locations", "Find possible Google locations by search query or location data.", { request: json },
    (t, p) => call(t, "information", "/googleLocations:search", { method: "POST", body: p.request }));
  add("gbp_associate_location", "Associate an unverified location with a matching place ID. Requires explicit confirmation.", {
    ...legacyLocation, placeId: id
  }, (t, p) => call(t, "legacy", `${legacyPath(p)}:associate`, { method: "POST", body: { placeId: p.placeId } }), true);
  add("gbp_report_google_location", "Report an incorrect Google location. Requires explicit confirmation.", {
    googleLocationId: id, report: json
  }, (t, p) => {
    const { reportReasonBadLocation, reportReasonBadRecommendation } = p.report;
    if (Boolean(reportReasonBadLocation) === Boolean(reportReasonBadRecommendation)) throw new Error("Provide exactly one Google location report reason.");
    return call(t, "legacy", `/googleLocations/${gbpId(p.googleLocationId)}:report`, { method: "POST", body: p.report });
  }, true);

  add("gbp_list_reviews", "List reviews, ratings, review text, dates, and owner replies.", {
    ...legacyLocation, orderBy: z.string().optional(), ...paging
  }, (t, p) => call(t, "legacy", `${legacyPath(p)}/reviews`, { query: { pageSize: p.pageSize, pageToken: p.pageToken, orderBy: p.orderBy } }));
  add("gbp_get_review", "Get one review and its owner reply.", { ...legacyLocation, reviewId: id },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/reviews/${gbpPathId(p.reviewId)}`));
  add("gbp_review_backlog", "Summarize ratings and unanswered reviews in one page; nextPageToken means more pages remain.", {
    ...legacyLocation, pageToken: z.string().optional(), pageSize: z.number().int().min(1).max(50).optional()
  }, async (t, p) => {
    const response = await call(t, "legacy", `${legacyPath(p)}/reviews`, { query: { pageSize: p.pageSize || 50, pageToken: p.pageToken } });
    if (!response.ok) return response;
    const reviews = response.body.reviews || [];
    const ratings = Object.fromEntries(["ONE", "TWO", "THREE", "FOUR", "FIVE"].map((rating) => [rating, reviews.filter((review) => review.starRating === rating).length]));
    return { ok: true, status: 200, body: {
      scope: "current_page_only", sampleSize: reviews.length, ratings,
      unanswered: reviews.filter((review) => !review.reviewReply).map((review) => ({ name: review.name, starRating: review.starRating, comment: review.comment, createTime: review.createTime })),
      nextPageToken: response.body.nextPageToken || null,
      aggregateRating: response.body.averageRating ?? null,
      totalReviewCount: response.body.totalReviewCount ?? null
    } };
  });
  add("gbp_publish_review_reply", "Publish a first owner reply only. Existing replies cannot be edited or deleted by this tool.", {
    ...legacyLocation, reviewId: id, comment: z.string().min(1).max(4096)
  }, async (t, p) => {
    const path = `${legacyPath(p)}/reviews/${gbpPathId(p.reviewId)}`;
    const existing = await call(t, "legacy", path);
    if (!existing.ok) return existing;
    if (existing.body.reviewReply) return { ok: false, status: 409, body: { error: "existing_reply", message: "This review already has an owner reply; editing is disabled." } };
    return call(t, "legacy", `${path}/reply`, { method: "PUT", body: { comment: p.comment } });
  }, true);

  add("gbp_list_posts", "List business posts for a location.", { ...legacyLocation, ...paging },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/localPosts`, { query: { pageSize: p.pageSize, pageToken: p.pageToken } }));
  add("gbp_get_post", "Get one business post.", { ...legacyLocation, postId: id },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/localPosts/${gbpPathId(p.postId)}`));
  add("gbp_create_post", "Create a business post. Requires explicit confirmation.", { ...legacyLocation, post: json },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/localPosts`, { method: "POST", body: p.post }), true);
  add("gbp_update_post", "Update a business post with an update mask. Requires explicit confirmation.", { ...legacyLocation, postId: id, post: json, updateMask: z.string().min(1) },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/localPosts/${gbpPathId(p.postId)}`, { method: "PATCH", query: { updateMask: p.updateMask }, body: p.post }), true);
  add("gbp_delete_post", "Delete a business post. Requires explicit confirmation.", { ...legacyLocation, postId: id },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/localPosts/${gbpPathId(p.postId)}`, { method: "DELETE" }), true);
  add("gbp_get_post_insights", "Get available post insights for selected post resource names; basicRequest selects supported metrics.", {
    ...legacyLocation, localPostNames: z.array(id).min(1).max(100), basicRequest: json.optional()
  }, (t, p) => call(t, "legacy", `${legacyPath(p)}/localPosts:reportInsights`, { method: "POST", body: {
    localPostNames: p.localPostNames, ...(p.basicRequest ? { basicRequest: p.basicRequest } : {})
  } }));

  add("gbp_list_media", "List business-owned photos and videos for a location.", { ...legacyLocation, ...paging },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/media`, { query: { pageSize: p.pageSize, pageToken: p.pageToken } }));
  add("gbp_get_media", "Get one business media item.", { ...legacyLocation, mediaId: id },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/media/${gbpPathId(p.mediaId)}`));
  add("gbp_create_media_from_url", "Add a photo from a public HTTPS source URL. Video creation is not supported by this API version. Requires explicit confirmation.", {
    ...legacyLocation, sourceUrl: z.string().url().startsWith("https://"), category: z.string().min(1), description: z.string().optional()
  }, (t, p) => {
    if (p.category === "COVER" && p.description) throw new Error("Cover photos cannot have a description.");
    return call(t, "legacy", `${legacyPath(p)}/media`, { method: "POST", body: {
      mediaFormat: "PHOTO", locationAssociation: { category: p.category }, sourceUrl: p.sourceUrl,
      ...(p.description ? { description: p.description } : {})
    } });
  }, true);
  add("gbp_update_media", "Change a business-owned media category (not COVER or PROFILE). Requires explicit confirmation.", {
    ...legacyLocation, mediaId: id, category: z.string().min(1).refine((value) => !["COVER", "PROFILE"].includes(value), "COVER and PROFILE cannot be set by media PATCH.")
  }, (t, p) => call(t, "legacy", `${legacyPath(p)}/media/${gbpPathId(p.mediaId)}`, {
    method: "PATCH", query: { updateMask: "locationAssociation.category" }, body: { locationAssociation: { category: p.category } }
  }), true);
  add("gbp_delete_media", "Delete business-owned media. Requires explicit confirmation.", { ...legacyLocation, mediaId: id },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/media/${gbpPathId(p.mediaId)}`, { method: "DELETE" }), true);
  add("gbp_list_customer_media", "List customer-contributed media; this tool does not alter customer content.", { ...legacyLocation, ...paging },
    (t, p) => call(t, "legacy", `${legacyPath(p)}/media/customers`, { query: { pageSize: p.pageSize, pageToken: p.pageToken } }));

  add("gbp_get_daily_performance", "Fetch daily GBP Search/Maps impressions, website clicks, call clicks, directions, bookings, and available metrics.", {
    ...locationRead, startDate: date, endDate: date, dailyMetrics: z.array(z.enum(GBP_DAILY_METRICS)).min(1).optional()
  }, (t, p) => {
    if (p.startDate > p.endDate) throw new Error("startDate must not be after endDate.");
    return call(t, "performance", `${locationPath(p)}:fetchMultiDailyMetricsTimeSeries`, { query: {
      dailyMetrics: p.dailyMetrics || GBP_DAILY_METRICS,
      ...gbpDate(p.startDate, "dailyRange.startDate"), ...gbpDate(p.endDate, "dailyRange.endDate")
    } });
  });
  add("gbp_get_monthly_search_keywords", "Fetch monthly GBP discovery keywords and impression counts; no keyword click/CTR data.", {
    ...locationRead, startMonth: z.string().regex(/^\d{4}-\d{2}$/), endMonth: z.string().regex(/^\d{4}-\d{2}$/), ...paging
  }, (t, p) => {
    if (p.startMonth > p.endMonth) throw new Error("startMonth must not be after endMonth.");
    const [sy, sm] = p.startMonth.split("-").map(Number);
    const [ey, em] = p.endMonth.split("-").map(Number);
    if (sm < 1 || sm > 12 || em < 1 || em > 12) throw new Error("Months must be between 01 and 12.");
    return call(t, "performance", `${locationPath(p)}/searchkeywords/impressions/monthly`, { query: {
      "monthlyRange.startMonth.year": sy, "monthlyRange.startMonth.month": sm,
      "monthlyRange.endMonth.year": ey, "monthlyRange.endMonth.month": em,
      pageSize: p.pageSize, pageToken: p.pageToken
    } });
  });
  add("gbp_list_action_links", "Read booking, reservation, ordering, and other place action links.", { ...locationRead, ...paging },
    (t, p) => call(t, "actions", `${locationPath(p)}/placeActionLinks`, { query: { pageSize: p.pageSize, pageToken: p.pageToken } }));
  add("gbp_get_action_link", "Get one place action link.", { ...locationRead, linkId: id },
    (t, p) => call(t, "actions", `${locationPath(p)}/placeActionLinks/${gbpPathId(p.linkId)}`));
  add("gbp_list_action_types", "Discover available place action types for a location or country.", {
    languageCode: z.string().optional(), regionCode: z.string().optional(), locationId: z.string().optional(), ...paging
  }, (t, p) => {
    if (p.regionCode && p.locationId) throw new Error("Specify either regionCode or locationId, not both.");
    return call(t, "actions", "/placeActionTypeMetadata", { query: {
      languageCode: p.languageCode, pageSize: p.pageSize, pageToken: p.pageToken,
      filter: p.locationId ? `location=locations/${gbpId(p.locationId)}` : p.regionCode ? `region_code=${p.regionCode}` : undefined
    } });
  });
  add("gbp_get_lodging", "Read lodging details for an eligible hotel location; editing is disabled.", locationRead,
    (t, p) => call(t, "lodging", `${locationPath(p)}/lodging`));
  add("gbp_get_service_list", "Read a location's service list; editing is disabled.", legacyLocation,
    (t, p) => call(t, "legacy", `${legacyPath(p)}/serviceList`));
  add("gbp_get_food_menus", "Read available food menu data; editing is disabled.", legacyLocation,
    (t, p) => call(t, "legacy", `${legacyPath(p)}/foodMenus`));

  if (registered.join("|") !== GBP_TOOL_NAMES.join("|")) throw new Error("GBP tool catalog does not match registered tools.");
}
