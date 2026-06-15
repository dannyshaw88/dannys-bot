/**
 * Computes rich diagnostic context captured at the moment an account is flagged.
 * Used by banPipeline.ts and all flag-* route handlers.
 */

export interface AnalyticsContext {
  verifyCountLast24h: number;
  accountAgeDays: number | null;
  proxyAccountCount: number;
  followCountBeforeBan: number;
  sessionToActionRatio: string | null;
  spanHours: string | null;
  lastOperationBeforeBan: string | null;
}

const VERIFY_OPS = new Set([
  "VerifyAccount", "launcher/sync", "tokens/keyed", "qe/sync", "users/info",
]);

const FOLLOW_OPS = new Set([
  "FollowedUser", "friendships/create", "follow",
]);

const SESSION_OPS = new Set([
  "GetTimeLineFeed", "ViewTimelineFeedSeen", "GetReelsTray", "ViewUserFeed",
  "GetDirectMessages", "TopicalExplore", "ExecuteNotificationsBadge",
  "ViewTimelineStories", "VisitUserProfile", "ViewFeedPost", "LikeMedia",
  "SaveMedia", "feed/timeline", "discover/topical_explore", "feed/user",
  "direct_v2/inbox", "news/inbox", "media/like",
]);

const ACTION_OPS = new Set([
  "FollowedUser", "UnfollowUser", "friendships/create", "friendships/destroy",
  "direct_v2/broadcast", "follow", "unfollow", "dm",
]);

export function computeAnalyticsContext(
  calls: Array<{ operationName: string; date: string; source?: string | null }>,
  notes: string | null | undefined,
  proxyAccountCount: number,
): AnalyticsContext {
  const now = new Date();
  const last24hCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const verifyCountLast24h = calls.filter(
    c => VERIFY_OPS.has(c.operationName) && c.date >= last24hCutoff,
  ).length;

  let accountAgeDays: number | null = null;
  const notesStr = notes ?? "";
  const addedMatch = notesStr.match(/(?:Added|Re-added|Re-imported)[^:]*:\s*(\d{4}-\d{2}-\d{2})/);
  if (addedMatch) {
    const addedDate = new Date(addedMatch[1]);
    if (!isNaN(addedDate.getTime())) {
      accountAgeDays = Math.floor((now.getTime() - addedDate.getTime()) / 86400000);
    }
  }

  const followCountBeforeBan = calls.filter(c => FOLLOW_OPS.has(c.operationName)).length;

  const sessionCount = calls.filter(c => SESSION_OPS.has(c.operationName)).length;
  const actionCount = calls.filter(c => ACTION_OPS.has(c.operationName)).length;
  const sessionToActionRatio = actionCount > 0
    ? (sessionCount / actionCount).toFixed(4)
    : null;

  const timestamps = calls.map(c => new Date(c.date).getTime()).filter(t => !isNaN(t));
  let spanHours: string | null = null;
  if (timestamps.length >= 2) {
    const spanMs = Math.max(...timestamps) - Math.min(...timestamps);
    spanHours = (spanMs / 3_600_000).toFixed(4);
  }

  const lastOperationBeforeBan = calls.length > 0 ? calls[0].operationName : null;

  return {
    verifyCountLast24h,
    accountAgeDays,
    proxyAccountCount,
    followCountBeforeBan,
    sessionToActionRatio,
    spanHours,
    lastOperationBeforeBan,
  };
}
