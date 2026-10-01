# Getting Marketer Companion to end users

A plugin you create in ChatGPT ("Created by me") is private to your account. A personal
ChatGPT account cannot share it with other people. There are three ways to reach users:

| Route | Who can use it | What it takes |
|---|---|---|
| **Public plugin directory** | Anyone on ChatGPT; install in one click from **Plugins** | OpenAI review (below). This is the only route for the general public. |
| **Workspace plugin** | Members of a ChatGPT Business, Enterprise or Edu workspace | An admin uploads the ZIP in **Workspace settings → Plugins → Add → Upload plugin** and sets it to *Available* or *Installed*. No OpenAI review. |
| **Developer mode** | One Plus or Pro user at a time, web and desktop only | Each user adds the MCP URL themselves. Fine for testers and early clients; too fiddly for the public. |

The same server also works outside ChatGPT: Claude (custom connector), Claude Code, Codex CLI,
Gemini CLI, Cursor and VS Code. The user-facing guide at **https://ga4mcpjs.vercel.app/install**
covers every one, with copy-ready commands and a prompt people can paste into an AI agent to
set it up for them. It hides the ChatGPT directory option until `PLUGIN_DIRECTORY_LIVE=true`.

## Links to share

| Link | What it does |
|---|---|
| `https://ga4mcpjs.vercel.app/claude` | Opens Claude’s *Add connector* form with everything filled in (or the directory listing once `CLAUDE_DIRECTORY_URL` is set). The person clicks **Add** and **Connect**. |
| `https://ga4mcpjs.vercel.app/chatgpt` | The ChatGPT steps. |
| `https://ga4mcpjs.vercel.app/install` | Asks which app they use, then shows its steps. |

After connecting, people only need to ask *“Open my marketing dashboard for theirwebsite.com”*.
The dashboard finds that business’s GA4 property, Search Console site, Merchant Center account,
Business Profile location and CallRail account by name, plus a lone Google Ads account, and opens
without asking. With no business named, it uses every source that has a single account and only
shows the account picker when it cannot decide; the picker’s *Find your business* box fills the
rest from one name.

## 1. Deploy the server with the dashboard on

Set these in Vercel (Production) and redeploy:

| Variable | Value |
|---|---|
| `ENABLE_MARKETING_DASHBOARD` | `true` |
| `SUPPORT_EMAIL` | The address shown on the install, privacy and terms pages |
| `OPENAI_APPS_CHALLENGE` | The token OpenAI gives you for domain verification (step 4) |
| `PUBLIC_BASE_URL` | Optional. Only if you move to a custom domain, e.g. `https://mcp.thejayant.in`. The install page always shows an `https://` address |
| `CLAUDE_DIRECTORY_URL` | Leave unset. After the Claude directory listing is live, set it to the listing URL (`https://claude.ai/directory/connectors/<slug>`); the **Add to Claude** button then opens the listing instead of the prefilled custom-connector form |
| `PLUGIN_DIRECTORY_LIVE` | Leave unset. Set to `true` only after the listing is published; it adds the ChatGPT directory option to the install page |

Check that https://ga4mcpjs.vercel.app/install, /privacy and /terms load, and that the root
JSON at https://ga4mcpjs.vercel.app/ lists `open_marketing_dashboard`.

## 2. Google: let anyone sign in (the step most likely to block users)

Until the Google OAuth app is verified, Google limits it to 100 users and shows an
"unverified app" warning. All requested scopes are *sensitive* (none are *restricted*),
so verification needs no paid security assessment:

1. Google Cloud Console → **Google Auth Platform → Branding**: app name *Marketer Companion*,
   logo (`assets/logo.png`), home page `https://ga4mcpjs.vercel.app/install`, privacy policy
   `https://ga4mcpjs.vercel.app/privacy`, terms `https://ga4mcpjs.vercel.app/terms`, and
   `ga4mcpjs.vercel.app` as an authorised domain (verified in Search Console).
2. **Audience**: publishing status *In production*.
3. **Data access**: justify each scope (Analytics, Search Console, Ads, Merchant Center,
   Business Profile) and upload a short screen recording of the sign-in and of the
   dashboard using each one.
4. Submit for verification. Google usually replies within a few days to a few weeks.

The privacy policy already contains the Limited Use statement Google checks for.

## 3. Google Ads: raise the API quota before going public

The developer token has **Basic Access: 15,000 operations a day shared by every user**. A
dashboard load costs 2–3 operations, so a few hundred active users can exhaust it, and
then every user sees "quota exceeded" until the next day. Apply for **Standard Access**
in the Google Ads API Center before publishing. (Meta also needs App Review before
anyone outside your Meta app's testers can connect it.)

## 4. Submit to the OpenAI plugin directory

1. Verify your identity (individual or business) in your OpenAI organisation settings.
2. Build the package: `npm run package:plugin` → `dist/marketer-companion-dashboard-1.0.0.zip`.
3. Upload it in the [Plugins dashboard](https://platform.openai.com/plugins) and fix
   anything the automated checks flag.
4. Domain verification: put the challenge token OpenAI shows into `OPENAI_APPS_CHALLENGE`
   and redeploy. The server serves it at `/.well-known/openai-apps-challenge`.
5. Fill in the review details:
   - **Reviewer account**: a Google account with access to Google's public
     [GA4 demo account](https://support.google.com/analytics/answer/6367342) works for GA4.
     Add the same account as a user on a Search Console property and a Google Ads test or
     read-only account so the reviewer sees real data. Enter credentials only in the
     secure reviewer field, never in the ZIP.
   - **Video**: install → connect Google → "Open my marketing dashboard" → pick accounts →
     change dates → add a GA4 filter → switch breakdown → Ask ChatGPT.
   - **Test cases**: use the ones below.
6. Choose **Submit for review**, then publish once approved. Later server updates are
   picked up automatically; only manifest changes need a new submission.

### Positive test cases

1. "Open my marketing dashboard." → `open_marketing_dashboard`; the dashboard opens and
   asks the user to pick accounts.
2. "Show my GA4 sessions and key events for the last 28 days compared with the previous
   period." → `get_marketing_dashboard` with a GA4 property; totals with change percentages.
3. "Which Google Ads campaigns spent the most last month?" → `get_marketing_dashboard`
   with `options.google_ads.breakdown = campaign`; campaigns ranked by spend.
4. "What are my top Search Console queries on mobile?" → `get_marketing_dashboard` with
   `options.search_console.device = MOBILE`; queries ranked by clicks.
5. "List the accounts I can use in the dashboard." → `list_dashboard_accounts`; GA4
   properties, Search Console sites and Ads accounts the user can access.

### Negative test cases

1. "Delete my Google Ads campaign." → no tool call; the plugin explains it is read-only for Ads.
2. "Show me another company's GA4 data." → only accounts the signed-in user can access are
   listed; nothing else is fetched.
3. "Load data from 2010 to today." → the server rejects the range (1–366 days ending
   before today) and ChatGPT asks for a valid range.

## 5. List it in Claude's connector directory (one-click for Claude users)

Until it is listed, the install page's **Add to Claude** button opens Claude's *Add custom
connector* form with the name and address already filled in, so Claude users click **Add** and
**Connect**. A directory listing removes even that and lets Claude suggest it in chat.

1. On a paid Claude plan, open the developer portal at https://claude.ai/directory/manage and
   choose **MCP connector**.
2. Server URL `https://ga4mcpjs.vercel.app/mcp`; documentation `https://ga4mcpjs.vercel.app/install`;
   privacy policy `https://ga4mcpjs.vercel.app/privacy`; icon `assets/logo.png`; the same reviewer
   Google account as for OpenAI; dashboard screenshots for the MCP App carousel.
3. Accept the seven compliance acknowledgements and submit. Every tool already has a title and
   a read-only or destructive annotation, which the automated scan checks. Submissions are
   listed as **Community** connectors after the scan; Anthropic may later review them for
   **Verified**.
4. Set `CLAUDE_DIRECTORY_URL` to the listing URL you receive and redeploy.

Workspace admins can download the ChatGPT plugin package at
`https://ga4mcpjs.vercel.app/download/plugin.zip`; it is built from the deployed files.

## Updating

- **Server or dashboard changes**: deploy as usual. Users get them without reinstalling.
  Bump `DASHBOARD_URI` in `dashboard/server.js` when the dashboard HTML changes, because
  ChatGPT caches it by URI.
- **Manifest, name, logo or description changes**: bump `version` in `plugin.json`, run
  `npm run package:plugin`, and upload the new ZIP (directory submission or workspace
  **Upload new version**).
