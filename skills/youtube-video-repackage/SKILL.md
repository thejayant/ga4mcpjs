---
name: youtube-video-repackage
description: Rewrite YouTube titles, descriptions, tags and playlists so existing videos earn more clicks and session time, without breaking the ones that already rank. Use when asked to repackage, retitle, re-SEO or organize a channel's videos into playlists.
metadata:
  arguments: channel, scope
  tools: youtube_list_videos youtube_get_video youtube_top_videos youtube_video_report youtube_update_video youtube_list_playlists youtube_create_playlist youtube_add_to_playlist youtube_move_in_playlist
---

# YouTube video repackage

Goal: more impressions turned into views (CTR) and more views turned into binge sessions (playlists), while protecting videos that already win.

## 1. Measure before touching anything
1. `youtube_list_videos` for the channel (use `pageToken` until done) to get every video ID.
2. `youtube_top_videos` and `youtube_video_report` (last 90 days): views, impressions CTR, average view duration, traffic sources.
3. Sort videos into three groups:
   - **Protect**: top 20% by views or any video whose main traffic source is YouTube search. Do not change these titles. Only add missing description links and playlist placement.
   - **Fix**: impressions are high but CTR is under about 4%. Their packaging is the problem. Rewrite the title first.
   - **Revive**: few impressions. Rewrite title and description, and put them in a strong playlist.

## 2. Write titles that earn the click honestly
- Lead with the hook (moment, stakes or payoff), then the game or topic name, then the platform if it helps search (for example "PS5").
- 45 to 70 characters. Put the most important words in the first 40, because mobile cuts the rest.
- Curiosity is fine. Lying is not: the video must deliver what the title promises, or retention drops and YouTube buries it.
- Keep the series name consistent so related videos cluster in suggestions ("Part 3" goes at the end).
- Write 2 options per video and pick one. Never reuse the same title across videos.

## 3. Descriptions
- First 2 lines (about 150 characters) restate the hook with the main search phrase. That is what search and the "more" fold show.
- Then: a short summary, chapters (`00:00 Intro` and so on) when the video is longer than 3 minutes, a link to the series playlist, and 3 to 5 hashtags at the end.
- Keep any existing links and credits.

## 4. Playlists
- One playlist per game or series, in story order. Use `youtube_create_playlist`, `youtube_add_to_playlist`, `youtube_move_in_playlist`.
- Playlist titles are search assets too: "<Game> Full Walkthrough PS5 (No Commentary)" beats "My videos".

## 5. Ship safely
- Save the original title and description of every video before you change it (keep them in your reply or a file) so any change can be rolled back.
- Show the user a before and after table and wait for approval before calling `youtube_update_video`.
- Update in batches of up to 20 and watch quota: every update costs YouTube API units.
- Re-check CTR with `youtube_video_report` after 7 to 14 days and roll back titles that lost CTR.
