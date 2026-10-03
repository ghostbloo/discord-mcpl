/**
 * Feature set declarations for the Discord MCPL server.
 */

import type { FeatureSetDeclaration } from '@animalabs/mcpl-core';

export const featureSets: Record<string, FeatureSetDeclaration> = {
  'discord.messaging': {
    description: 'Send, read, react to messages in Discord channels',
    uses: ['tools', 'channels.publish'],
    rollback: true,
    // MCPL RFC-001 — tags carried on Discord message events (emits umbrellas
    // directly, so no host-side implication expansion is needed).
    tagOntology: {
      coreTags: [
        'chat:addressed', 'chat:mention', 'chat:reply', 'chat:dm', 'chat:ambient',
        'chat:private', 'chat:from-human', 'chat:from-bot', 'chat:thread',
        'chat:reaction',
        'chat:has-image', 'chat:has-audio', 'chat:has-file',
      ],
      defaultTreatment: [
        { tagsAny: ['chat:addressed'], behavior: 'immediate' },
        { tagsAny: ['chat:ambient', 'chat:from-bot'], behavior: { throttle: { perMs: 120000 } } },
      ],
      // Discord-specific extensions (e.g. discord:everyone, discord:slash) may be
      // emitted in future; consumers should tolerate undeclared tags.
      open: true,
    },
  },
  'discord.channels': {
    description: 'Create, delete, and manage Discord channels',
    uses: ['tools'],
    rollback: false,
  },
  'discord.history': {
    description: 'Fetch message history from Discord channels',
    uses: ['tools'],
    rollback: false,
  },
  'discord.subscriptions': {
    description:
      'Manage per-channel ambient-message subscriptions (which channels deliver ' +
      'non-mention messages for passive awareness). Mentions and DMs are always ' +
      'delivered and are not affected by subscriptions.',
    uses: ['tools'],
    rollback: false,
  },
};

/** Check if a feature set is in a given enabled list. */
export function isEnabled(name: string, enabledSets: Set<string>): boolean {
  // Check exact match
  if (enabledSets.has(name)) return true;
  // Check wildcard (e.g., "discord.*")
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.') + '.*';
    if (enabledSets.has(prefix)) return true;
  }
  return false;
}

/** Get the feature set that owns a given tool. Returns undefined for always-available tools. */
export function featureSetForTool(toolName: string): string | undefined {
  switch (toolName) {
    case 'send_message':
    case 'reply_message':
    case 'send_dm':
    case 'add_reaction':
    case 'list_emojis':
    case 'edit_message':
    case 'delete_message':
      return 'discord.messaging';
    case 'create_text_channel':
    case 'delete_channel':
      return 'discord.channels';
    case 'fetch_history':
    case 'fetch_around':
      return 'discord.history';
    case 'subscribe_channel':
    case 'unsubscribe_channel':
    case 'mute_channel':
    case 'unmute_channel':
    case 'list_subscriptions':
    case 'channel_missed':
    case 'set_reaction_visibility':
      return 'discord.subscriptions';
    case 'list_guilds':
    case 'list_channels':
    case 'refresh_channels':
    case 'filters_get':
    case 'filters_update':
      return undefined; // Always available
    default:
      return undefined;
  }
}
