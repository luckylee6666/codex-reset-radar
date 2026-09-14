import { decodeEntities } from './fetch.js';

/** X 公开的 web bearer（固定常量，不是密钥） */
const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** UserTweets 的 operation id 会周期性轮换，按顺序尝试，都失败可按需覆盖 */
export const DEFAULT_QUERY_IDS = [
  'E3opETHurmVJflFsUBVuUQ',
  'HuTx74BxAnezK1gWvYY7zg',
  'V7H0Ap3_Hh2FyS75OCDO3Q',
  'QqZBEqganhHwmU9QscwObA',
  '6b1Z9nYPuD9WcRIDtEwSFw',
];

const FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

export function isGraphqlConfigured(config = {}) {
  return Boolean(config.xAuthToken && config.xCt0);
}

function graphqlHeaders(config) {
  return {
    authorization: `Bearer ${BEARER}`,
    'x-csrf-token': config.xCt0,
    cookie: `auth_token=${config.xAuthToken}; ct0=${config.xCt0}`,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    referer: 'https://x.com/',
  };
}

function normalizeGraphqlTweet(legacy, user) {
  const createdAt = legacy.created_at ? new Date(legacy.created_at) : null;
  const valid = createdAt && !Number.isNaN(createdAt.getTime());
  const media = (
    legacy.extended_entities?.media ??
    legacy.entities?.media ??
    []
  ).map((m) => ({ type: m.type ?? 'photo', url: m.media_url_https ?? '' }));
  return {
    id: String(legacy.id_str),
    createdAt: valid ? createdAt.toISOString() : new Date().toISOString(),
    createdTs: valid ? createdAt.getTime() : Date.now(),
    text: decodeEntities(legacy.full_text ?? ''),
    favoriteCount: legacy.favorite_count ?? 0,
    replyCount: legacy.reply_count ?? 0,
    retweetCount: legacy.retweet_count ?? 0,
    quoteCount: legacy.quote_count ?? 0,
    permalink: `https://x.com/${user?.screen_name ?? 'i'}/status/${legacy.id_str}`,
    avatar: user?.profile_image_url_https ?? '',
    authorName: user?.name ?? '',
    authorHandle: user?.screen_name ?? '',
    lang: legacy.lang ?? '',
    media: media.filter((m) => m.url),
  };
}

export function parseUserTweetsResponse(data) {
  const instructions =
    data?.data?.user?.result?.timeline_v2?.timeline?.instructions ??
    data?.data?.user?.result?.timeline?.instructions ??
    [];
  const tweets = [];
  for (const instruction of instructions) {
    for (const entry of instruction.entries ?? []) {
      const result =
        entry?.content?.itemContent?.tweet_results?.result ??
        entry?.content?.itemContent?.tweet_results?.result?.tweet;
      const legacy = result?.legacy;
      if (!legacy?.id_str) continue;
      const user = result?.core?.user_results?.result?.legacy ?? null;
      tweets.push(normalizeGraphqlTweet(legacy, user));
    }
  }
  return tweets;
}

/** UserByScreenName 的 operation id 同样会轮换，用于解析数字用户 ID */
export const USER_BY_NAME_QUERY_IDS = [
  'G3KGOASz96M-Qu0nwmGXNg',
  'sLVLhk0bGj3MVFEKTdax1w',
  'qW5u-DAuXpMEG0nnrzv_KQ',
  '1VOOyvKkiI3FMmkeDNxM9A',
];

export async function resolveUserIdGraphql(config, handle) {
  if (!isGraphqlConfigured(config)) throw new Error('未配置 X Cookie');
  const params = new URLSearchParams({
    variables: JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true }),
  });
  let lastError = 'UserByScreenName 全部 queryId 失败';
  for (const queryId of USER_BY_NAME_QUERY_IDS) {
    const res = await fetch(
      `https://x.com/i/api/graphql/${queryId}/UserByScreenName?${params}`,
      { headers: graphqlHeaders(config), signal: AbortSignal.timeout(15000) },
    );
    if (res.status === 401 || res.status === 403) throw new Error(`Cookie 无效或已过期（HTTP ${res.status}）`);
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    const data = await res.json();
    const id = data?.data?.user?.result?.rest_id;
    if (id) return String(id);
    lastError = data?.errors?.[0]?.message ?? '响应为空';
  }
  throw new Error(lastError);
}

/** 用 Cookie 调内部 GraphQL 拉取用户时间线 */
export async function fetchUserTweetsGraphql(config, userId) {
  if (!isGraphqlConfigured(config)) throw new Error('未配置 X Cookie');
  const queryIds = config.xUserTweetsQueryId
    ? [config.xUserTweetsQueryId, ...DEFAULT_QUERY_IDS]
    : DEFAULT_QUERY_IDS;

  const variables = {
    userId,
    count: 20,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: true,
    withVoice: true,
    withV2Timeline: true,
  };
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(FEATURES),
  });

  let lastError = 'GraphQL 全部 queryId 失败';
  for (const queryId of queryIds) {
    const url = `https://x.com/i/api/graphql/${queryId}/UserTweets?${params}`;
    const res = await fetch(url, {
      headers: graphqlHeaders(config),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Cookie 无效或已过期（HTTP ${res.status}）`);
    }
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    const data = await res.json();
    if (data?.errors?.length && !data?.data) {
      lastError = data.errors[0]?.message ?? 'GraphQL 错误';
      continue;
    }
    const tweets = parseUserTweetsResponse(data);
    if (tweets.length) return tweets;
    lastError = '响应为空';
  }
  throw new Error(lastError);
}
