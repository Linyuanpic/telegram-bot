export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
export const DEFAULT_D1_BINDING = "DB";
export const DEFAULT_KV_BINDING = "KV";
export const TEMPLATE_SORT_ORDER = [
  "start",
  "ask_code",
  "support_open",
  "support_closed",
  "support_closed_spam",
  "vip_new",
  "vip_renew",
  "image_limit_nonmember",
  "image_limit_member",
  "image_limit",
  "exp_before_30d",
  "exp_before_15d",
  "exp_before_7d",
  "exp_before_3d",
  "exp_before_1d",
  "nonmember_monthly",
  "exp_after_1d",
  "exp_after_3d",
  "exp_after_7d",
  "exp_after_15d",
  "exp_after_30d",
];
export const IMAGE_REPLY_TEMPLATE_KEY = "image_reply";
export const SUPPORT_CLOSED_TEMPLATE_KEY = "support_closed";
export const IMAGE_LIMIT_MEMBER_TEMPLATE_KEY = "image_limit_member";
export const IMAGE_LIMIT_NONMEMBER_TEMPLATE_KEY = "image_limit_nonmember";
export const IMAGE_REPLY_DEFAULT_TEXT = "自助搜图，具体内容点击下方按钮～";
export const IMAGE_REPLY_DEFAULT_BUTTONS = [
  [{ text: "GoogleLens → 看看这是谁", type: "url", url: "{{google_lens}}" }],
  [{ text: "Yandex.ru → 想找图片来源", type: "url", url: "{{yandex}}" }]
];
export const IMAGE_PROXY_PREFIX = "/tgimg";
export const IMAGE_PROXY_TTL_SEC = 12 * 60 * 60;
export const IMAGE_PROXY_CACHE_TTL_SEC = 7 * 24 * 3600;
export const IMAGE_PROXY_RATE_LIMIT = 3;
export const IMAGE_PROXY_RATE_WINDOW = 60;
export const FILE_PATH_CACHE_TTL = 7 * 24 * 3600;
export const CARD_CODE_LENGTH = 18;
export const IMAGE_DAILY_LIMIT_MEMBER = 100;
export const IMAGE_DAILY_LIMIT_NON_MEMBER = 5;
export const SUPPORT_SPAM_BAN_TTL_SEC = 60 * 60;
export const WEEKDAY_INDEX = {
  Sun: 7,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
