export type MessageListEmphasis = "agent" | "thread";

export type UserPreferences = {
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting ChisaBot. */
  selfHostBannerDismissed: boolean;
  /** The Bot pinned at the top of the roster as this person's main Bot, or null for none. */
  mainBotId: string | null;
  /** 左上角品牌名里红字黑边的那一段（默认 Chisa）。每个人自己改，跟着账号走。 */
  brandAccent: string;
  /** 品牌名里普通字的那一段（默认 Bot）。 */
  brandRest: string;
};

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  messageListEmphasis: "thread",
  selfHostBannerDismissed: false,
  mainBotId: null,
  brandAccent: "Chisa",
  brandRest: "Bot",
};
