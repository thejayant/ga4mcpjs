// MCP tools for connected platforms. Every tool identifies the user from the verified MCP
// token (an anonymous ID), loads that user's encrypted connection, and calls the platform.
// Connections made before user IDs existed get a clear "reconnect once" message.
import { z } from "zod";
import { PROVIDERS, publicConnection, bingCall, clarityInsights, CLARITY_DIMENSIONS } from "./providers.js";
import { connectionsLink } from "./routes.js";

export const CONNECTION_TOOL_NAMES = ["manage_connections", "bing_webmaster_sites", "bing_webmaster_traffic", "bing_webmaster_queries", "bing_webmaster_pages", "clarity_insights"];

const siteInput = { siteUrl: z.string().min(4).max(300).describe("A verified site exactly as listed by bing_webmaster_sites, e.g. https://www.example.com/") };

export function registerConnectionTools(server, { req, store, seal, withAuth, result, baseUrl }) {
  // Runs a tool for the signed-in user; `needs` names the platform connection it requires.
  const forUser = (needs, run) => async (args = {}) => withAuth(req, [], async auth => {
    if (!store) return result({ error: "connections_unavailable", error_description: "Connections are not set up on this server yet." }, true);
    if (!auth.userId) return result({ error: "reconnect_required", error_description: "Disconnect and reconnect Marketer Companion once to use connected platforms. Your existing tools keep working meanwhile." }, true);
    if (!needs) return run({ auth, args });
    const record = await store.get(auth.userId, needs);
    if (!record) {
      const link = connectionsLink(baseUrl(req), seal, auth.userId);
      return result({ error: "not_connected", error_description: `${PROVIDERS[needs].name} is not connected. Open this private link to connect it, then ask again.`, connectUrl: link.url, linkExpiresAt: link.expiresAt }, true);
    }
    return run({ auth, args, credentials: record.credentials });
  });
  const reply = (response, shape = body => body) => response.ok
    ? result(shape(response.body))
    : result({ error: "platform_error", status: response.status, error_description: typeof response.body === "string" ? response.body.slice(0, 300) : response.body?.message || response.body?.Message || `The platform returned ${response.status}.` }, true);

  server.registerTool("manage_connections", {
    title: "Manage Connections",
    description: `Connect or disconnect extra platforms (${Object.values(PROVIDERS).map(p => p.name).join(", ")}). Returns the platforms already connected and a private link, valid 30 minutes, to a page where the user connects them. Give the user the link; never ask for keys in chat.`,
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, forUser(null, async ({ auth }) => {
    const ids = await store.list(auth.userId);
    const connected = (await Promise.all(ids.map(async id => publicConnection(id, await store.get(auth.userId, id))))).filter(Boolean);
    const link = connectionsLink(baseUrl(req), seal, auth.userId);
    return result({ connected, available: Object.entries(PROVIDERS).filter(([id]) => !ids.includes(id)).map(([id, p]) => ({ provider: id, name: p.name, category: p.category })), manageUrl: link.url, linkExpiresAt: link.expiresAt });
  }));

  server.registerTool("bing_webmaster_sites", {
    title: "Bing Webmaster Sites", description: "List the sites in the user's Bing Webmaster Tools account and whether each is verified.",
    inputSchema: {}, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials }) => reply(await bingCall(credentials.apiKey, "GetUserSites"), sites => ({ sites: (sites || []).map(site => ({ url: site.Url, verified: site.IsVerified })) }))));

  server.registerTool("bing_webmaster_traffic", {
    title: "Bing Webmaster Traffic", description: "Daily Bing search clicks and impressions for a verified site (Bing keeps about six months).",
    inputSchema: siteInput, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials, args }) => reply(await bingCall(credentials.apiKey, "GetRankAndTrafficStats", { siteUrl: args.siteUrl }), rows => ({ siteUrl: args.siteUrl, days: (rows || []).map(row => ({ date: row.Date, clicks: row.Clicks, impressions: row.Impressions })) }))));

  server.registerTool("bing_webmaster_queries", {
    title: "Bing Webmaster Queries", description: "Top Bing search queries for a verified site with clicks, impressions and average positions.",
    inputSchema: siteInput, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials, args }) => reply(await bingCall(credentials.apiKey, "GetQueryStats", { siteUrl: args.siteUrl }), rows => ({ siteUrl: args.siteUrl, queries: (rows || []).slice(0, 200) }))));

  server.registerTool("bing_webmaster_pages", {
    title: "Bing Webmaster Pages", description: "Top pages in Bing search for a verified site with clicks, impressions and average positions.",
    inputSchema: siteInput, annotations: { readOnlyHint: true }
  }, forUser("bing_webmaster", async ({ credentials, args }) => reply(await bingCall(credentials.apiKey, "GetPageStats", { siteUrl: args.siteUrl }), rows => ({ siteUrl: args.siteUrl, pages: (rows || []).slice(0, 200) }))));

  server.registerTool("clarity_insights", {
    title: "Microsoft Clarity Insights",
    description: `Microsoft Clarity behaviour data for the last 1–3 days: sessions, bot sessions, pages per session, scroll depth, engagement time, dead, rage, quick-back and error clicks, and JavaScript errors, broken down by up to three of: ${CLARITY_DIMENSIONS.join(", ")}. Clarity allows 10 requests a day per project, so identical requests are served from a one-hour cache.`,
    inputSchema: {
      numOfDays: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("Last 24, 48 or 72 hours (default 3)"),
      dimensions: z.array(z.enum(CLARITY_DIMENSIONS)).max(3).optional()
    },
    annotations: { readOnlyHint: true }
  }, forUser("clarity", async ({ auth, credentials, args }) => {
    const numOfDays = args.numOfDays || 3, dimensions = args.dimensions || [];
    const response = await store.cached(`clarity:${auth.userId}:${numOfDays}:${dimensions.join(",")}`, 3600, () => clarityInsights(credentials.token, { numOfDays, dimensions }));
    if (response.status === 429) return result({ error: "daily_limit", error_description: "Clarity's limit of 10 requests a day for this project is used up. Try again tomorrow, or reuse an earlier answer." }, true);
    return reply(response, metrics => ({ numOfDays, dimensions, servedFromCache: Boolean(response.cached), metrics }));
  }));
}
