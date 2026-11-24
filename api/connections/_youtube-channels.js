// Several YouTube channels per user, up to MAX_YOUTUBE_CHANNELS. Each YouTube sign-in shares one
// channel (Google asks which one when an account manages several, including Brand Accounts) and
// is stored as "youtube:<hash of the channel ID>"; a channel connected before this is stored as
// plain "youtube" and keeps working. A tool call picks its channel from `channel`, the profile
// connector's channel, the only channel connected, or the owner of the video or playlist it names.

export const MAX_YOUTUBE_CHANNELS = 5;
export const isYouTubeId = id => id === "youtube" || String(id).startsWith("youtube:");
// Tools that only read public YouTube data: any connected channel's sign-in can serve them.
export const ANY_CHANNEL_TOOLS = new Set(["youtube_search", "youtube_public_videos", "youtube_public_channel"]);

export async function listYouTubeChannels(store, userId) {
  const ids = (await store.list(userId)).filter(isYouTubeId).sort();
  const entries = await Promise.all(ids.map(async id => ({ id, record: await store.get(userId, id) })));
  return entries.filter(entry => entry.record).map(({ id, record }) => ({
    id, record,
    channelId: record.meta?.channelId || null,
    title: record.meta?.title || record.label || "YouTube channel",
    googleAccount: record.meta?.email || null
  }));
}

export const channelSummary = channel => ({ channel: channel.title, channelId: channel.channelId, ...(channel.googleAccount ? { googleAccount: channel.googleAccount } : {}) });

// A channel by connection ID, channel ID, exact title, or a title fragment that matches only one.
export function matchChannel(channels, wanted) {
  const text = String(wanted || "").trim().toLowerCase();
  if (!text) return null;
  const exact = channels.find(c => c.id.toLowerCase() === text || (c.channelId || "").toLowerCase() === text || c.title.toLowerCase() === text);
  if (exact) return exact;
  const partial = channels.filter(c => c.title.toLowerCase().includes(text));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Picks the channel for a tool call. `pinned` is a profile connector's channel (connection ID),
 * `anyChannel` marks public-data tools, `ownerOf()` returns the channel ID owning the video or
 * playlist the call names (or null). Returns { channel } or { error, message, channels }.
 */
export async function pickYouTubeChannel({ channels, wanted, pinned, anyChannel = false, ownerOf }) {
  if (!channels.length) return { error: "not_connected" };
  const list = channels.map(channelSummary);
  if (pinned) {
    const own = channels.find(channel => channel.id === pinned);
    if (!own) return { error: "profile_channel_missing", message: "This profile's YouTube channel was disconnected. Choose another channel for the profile on the Connections page." };
    if (wanted && matchChannel([own], wanted) !== own) return { error: "other_channel", message: `This connector is set to the YouTube channel "${own.title}". Use the connector or profile of the other channel.` };
    return { channel: own };
  }
  if (wanted) {
    const match = matchChannel(channels, wanted);
    return match ? { channel: match } : { error: "unknown_channel", message: `No connected YouTube channel matches "${wanted}".`, channels: list };
  }
  if (channels.length === 1 || anyChannel) return { channel: channels[0] };
  const owner = ownerOf ? await ownerOf().catch(() => null) : null;
  const owning = owner && channels.find(channel => channel.channelId === owner);
  if (owning) return { channel: owning };
  return { error: "choose_channel", message: `${channels.length} YouTube channels are connected. Say which one with \`channel\` (its name or ID), then ask again.`, channels: list };
}
