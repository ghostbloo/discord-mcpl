export interface Env {
  /**
   * Required: Discord bot token
   */
  DISCORD_TOKEN: string;

  /**
   * Optional: Comma-separated guild ID filter. Each entry is `guildId` (all channels) or `guildId:chanId+chanId` (whitelist those channels + their threads only)
   */
  DISCORD_GUILD_ID: string | undefined;

  /**
   * Optional: Comma-separated user ID whitelist for DMs. When set, DMs from anyone else are dropped.
   */
  DISCORD_DM_USERS: string | undefined;

  /**
   * Optional: Comma-separated user IDs allowed to use admin slash commands (/undo). Unset = nobody.
   */
  DISCORD_ADMIN_USERS: string | undefined;

  /**
   * Optional: path to a JSON file holding the guild/ channel + DM whitelists and the operator-maintained suppressedReactionEmojis list (see filters.ts for schema). When set, the file wins over DISCORD_GUILD_ID / DISCORD_DM_USERS (and is seeded from them if absent), and edits to it are HOT-RELOADED within ~3s — no restart. Also enables the filters_get/filters_update agent tools.
   */
  DISCORD_FILTERS_FILE: string | undefined;

  /**
   * Deprecated compat source for reaction suppression (comma-separated). Seeds the filters file's suppressedReactionEmojis key on first materialization; ignored once a filters file carries the key. Process-static: read once at startup, changes require a restart (hot reload belongs to the file plane). Retires per issue #16.
   * 
   * @deprecated
   */
  DISCORD_SUPPRESS_REACTION_EMOJIS: string | undefined;

  /**
   * Host-injected protective baseline for reaction suppression (comma-separated).
   * 
   * Applies (and seeds the filters file on first materialization) only when no operator configuration exists: a file key — including an explicit [] — or the legacy env above always wins, never unioned. Intended to be set by host composition from the Agent Framework's annotation map; standalone deployments leave it unset. Process-static, not deprecated.
   */
  DISCORD_SUPPRESSED_REACTIONS_BASELINE: string | undefined;

  AGENT_TIMEZONE: string | undefined;

  DISCORD_VOICE_CHANNEL_ID: string | undefined;
  DISCORD_VOICE_GUILD_ID: string | undefined;
  DISCORD_VOICE_REGISTRY_FILE: string | undefined;
  DISCORD_VOICE_NAME: string | undefined;
  ELEVENLABS_API_KEY: string | undefined;
  DISCORD_VOICE_TEXT_CHANNELS: string | undefined;
  DISCORD_VOICE_VAD_DB: string | undefined;
  DISCORD_VOICE_MAX_HOLD_MS: string | undefined;
}
