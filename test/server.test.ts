/**
 * Integration tests for DiscordMcplServer.
 * Uses a mock Discord adapter (no real Discord connection).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as net from 'node:net';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  McplConnection,
  method,
} from '@animalabs/mcpl-core';

import type {
  McplInitializeParams,
  McplInitializeResult,
  McplCapabilities,
  ChannelsRegisterParams,
  ChannelsIncomingParams,
  PushEventParams,
  ChannelsOpenResult,
  ChannelsPublishResult,
} from '@animalabs/mcpl-core';

import { DiscordMcplServer } from '../src/server.js';
import { applyMentionCandidates } from '../src/discord-adapter.js';
import type {
  DiscordAdapter,
  DiscordMessageData,
  DiscordChannelInfo,
  MentionCandidate,
} from '../src/discord-adapter.js';

// ── Mock Discord Adapter ──

class MockDiscordAdapter {
  private _messageHandler?: (msg: DiscordMessageData) => void;
  private _channelCreateHandler?: (guildId: string, channel: DiscordChannelInfo) => void;
  private _channelDeleteHandler?: (guildId: string, channelId: string) => void;
  private _guildCreateHandler?: (
    guildId: string,
    guildName: string,
    channels: DiscordChannelInfo[],
  ) => void;
  private _channelAvailableHandler?: (guildId: string, channel: DiscordChannelInfo) => void;

  sentMessages: Array<{ channelId: string; content: string; replyTo?: string }> = [];
  deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  private nextMessageId = 1;

  get isConnected(): boolean { return true; }
  get botUserId(): string | null { return 'bot_123'; }

  onMessage(handler: (msg: DiscordMessageData) => void): void {
    this._messageHandler = handler;
  }
  onMessageEdit(): void {}
  onMessageDelete(): void {}
  onReaction(): void {}
  onReady(): void {}
  onChannelCreate(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this._channelCreateHandler = handler;
  }
  onChannelDelete(handler: (guildId: string, channelId: string) => void): void {
    this._channelDeleteHandler = handler;
  }
  onGuildCreate(
    handler: (guildId: string, guildName: string, channels: DiscordChannelInfo[]) => void,
  ): void {
    this._guildCreateHandler = handler;
  }
  onChannelAvailable(handler: (guildId: string, channel: DiscordChannelInfo) => void): void {
    this._channelAvailableHandler = handler;
  }
  getGuildName(guildId: string): string {
    return guildId === 'g1' ? 'Test Guild' : guildId;
  }

  async sendMessage(channelId: string, content: string, options?: { replyTo?: string }): Promise<{ messageId: string }> {
    const id = `msg_${this.nextMessageId++}`;
    this.sentMessages.push({ channelId, content, replyTo: options?.replyTo });
    return { messageId: id };
  }

  async sendDM(userId: string, content: string): Promise<{ messageId: string }> {
    const id = `dm_${this.nextMessageId++}`;
    this.sentMessages.push({ channelId: `dm:${userId}`, content });
    return { messageId: id };
  }

  async editMessage(): Promise<void> {}

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    this.deletedMessages.push({ channelId, messageId });
  }

  async addReaction(): Promise<void> {}

  /** Messages the next fetchHistory/fetchAround call should return. Tests set
   *  this to drive the reconnect catch-up sweep. */
  historyToReturn: Array<{
    id: string; authorId: string; authorName: string; isBot: boolean;
    content: string; cleanContent: string; attachments: never[]; mentionsBot: boolean; timestamp: Date;
  }> = [];
  channelMeta = { name: 'general', guildId: 'g1', guildName: 'Test Guild', isDM: false };

  async fetchHistory(): Promise<MockDiscordAdapter['historyToReturn']> {
    return this.historyToReturn;
  }

  async fetchAround(): Promise<MockDiscordAdapter['historyToReturn']> {
    return this.historyToReturn;
  }

  async getChannelMeta(): Promise<MockDiscordAdapter['channelMeta']> {
    return this.channelMeta;
  }

  async listGuilds(): Promise<Array<{ id: string; name: string; memberCount: number }>> {
    return [{ id: 'g1', name: 'Test Guild', memberCount: 10 }];
  }

  async listChannels(): Promise<DiscordChannelInfo[]> {
    return [
      { id: 'c1', name: 'general', type: 'text' },
      { id: 'c2', name: 'dev', type: 'text' },
    ];
  }

  async createTextChannel(): Promise<DiscordChannelInfo> {
    return { id: 'c_new', name: 'new-channel', type: 'text' };
  }

  async deleteChannel(): Promise<void> {}

  getTextChannels(): Array<{ guildId: string; guildName: string; channel: DiscordChannelInfo }> {
    return [
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c1', name: 'general', type: 'text' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c2', name: 'dev', type: 'text' } },
    ];
  }

  /** Simulate an incoming Discord message (for push event / channels/incoming tests). */
  simulateMessage(msg: DiscordMessageData): void {
    this._messageHandler?.(msg);
  }

  /** Simulate the bot joining a new guild after startup. */
  simulateGuildCreate(guildId: string, guildName: string, channels: DiscordChannelInfo[]): void {
    this._guildCreateHandler?.(guildId, guildName, channels);
  }

  /** Simulate the bot being granted access to a pre-existing channel. */
  simulateChannelAvailable(guildId: string, channel: DiscordChannelInfo): void {
    this._channelAvailableHandler?.(guildId, channel);
  }
}

// ── Test Helpers ──

async function createTestPair(): Promise<{
  client: McplConnection;
  serverConn: McplConnection;
  discord: MockDiscordAdapter;
}> {
  const tcpServer = net.createServer();
  tcpServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => tcpServer.once('listening', resolve));
  const addr = tcpServer.address() as net.AddressInfo;

  const [serverConn, clientSocket] = await Promise.all([
    McplConnection.acceptTcp(tcpServer),
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: addr.port }, () => resolve(socket));
      socket.once('error', reject);
    }),
  ]);

  const client = McplConnection.fromTcp(clientSocket);
  const discord = new MockDiscordAdapter();

  tcpServer.close();
  return { client, serverConn, discord };
}

/** Perform MCPL handshake from client side with MCPL capabilities. */
async function mcplHandshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {
      experimental: {
        mcpl: {
          version: '0.4',
          pushEvents: true,
          channels: true,
          rollback: true,
        },
      },
    },
    clientInfo: { name: 'test-client', version: '0.1.0' },
  };

  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

/** Perform MCP-only handshake (no MCPL capabilities). */
async function mcpHandshake(client: McplConnection): Promise<McplInitializeResult> {
  const params: McplInitializeParams = {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-mcp-client', version: '0.1.0' },
  };

  const result = (await client.sendRequest('initialize', params)) as McplInitializeResult;
  client.sendNotification('notifications/initialized');
  return result;
}

// ── Tests ──

describe('DiscordMcplServer', () => {
  it('MCPL handshake exposes feature sets and channels', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);

    // Start server in background
    const serverPromise = server.serve(serverConn);

    // Client: handshake + accept channel registration
    const initResult = await mcplHandshake(client);

    assert.equal(initResult.serverInfo.name, 'discord-mcpl');
    const mcpl = initResult.capabilities.experimental?.mcpl as McplCapabilities;
    assert.ok(mcpl);
    assert.equal(mcpl.pushEvents, true);
    assert.equal(mcpl.channels, true);
    assert.equal(mcpl.rollback, true);
    assert.ok(mcpl.featureSets);
    assert.ok(typeof mcpl.featureSets === 'object');
    assert.equal(Object.keys(mcpl.featureSets).length, 4);
    assert.equal(Object.keys(mcpl.featureSets)[0], 'discord.messaging');
    assert.ok(
      'discord.subscriptions' in mcpl.featureSets,
      'discord.subscriptions feature set should be declared',
    );

    // Server should register channels — accept the request
    const regMsg = await client.nextMessage();
    assert.equal(regMsg.type, 'request');
    if (regMsg.type === 'request') {
      assert.equal(regMsg.request.method, 'channels/register');
      const p = regMsg.request.params as ChannelsRegisterParams;
      assert.equal(p.channels.length, 2);
      assert.equal(p.channels[0].type, 'discord');
      client.sendResponse(regMsg.request.id, {});
    }

    client.close();
    await serverPromise;
  });

  it('MCP-only handshake omits MCPL extensions', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    const initResult = await mcpHandshake(client);

    assert.equal(initResult.serverInfo.name, 'discord-mcpl');
    // No MCPL capabilities in MCP mode
    assert.equal(initResult.capabilities.experimental, undefined);
    // But tools should be declared
    assert.ok(initResult.capabilities.tools);

    client.close();
    await serverPromise;
  });

  it('answers featureSets/update sent as a Request (MCPL 0.5 initial policy)', async () => {
    // A 0.5 host waits ~15s for this receipt; unanswered, it leaves the grant
    // empty and the connection MCP-only, so no inbound Discord events arrive.
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    const receipt = (await Promise.race([
      client.sendRequest('featureSets/update', { enabled: ['discord.messaging'] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('featureSets/update request went unanswered')), 2000)),
    ])) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);

    client.close();
    await serverPromise;
  });

  it('answers featureSets/update before the host has replied to channels/register', async () => {
    // A 0.5 host sends the policy Request right after initialize. The server's
    // own channels/register (and the reconnect sweep) must not keep the main
    // loop from reading it, or the host times out and stays MCP-only.
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage(); // channels/register — deliberately not answered yet
    assert.equal(regMsg.type, 'request');

    const receipt = (await Promise.race([
      client.sendRequest('featureSets/update', { enabled: ['discord.messaging'] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('featureSets/update blocked behind channels/register')), 2000)),
    ])) as { accepted?: boolean };
    assert.equal(receipt.accepted, true);

    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});
    client.close();
    await serverPromise;
  });

  it('tools/list returns tool definitions', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/list', {})) as { tools: Array<{ name: string }> };
    assert.ok(result.tools.length > 0);
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('send_message'));
    assert.ok(names.includes('list_channels'));
    assert.ok(names.includes('fetch_history'));

    client.close();
    await serverPromise;
  });

  it('tools/call send_message works', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'send_message',
      arguments: { channelId: 'c1', content: 'Hello from test!' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    assert.ok(!result.isError);
    assert.equal(discord.sentMessages.length, 1);
    assert.equal(discord.sentMessages[0].channelId, 'c1');
    assert.equal(discord.sentMessages[0].content, 'Hello from test!');

    client.close();
    await serverPromise;
  });

  it('tools/call list_guilds works', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcpHandshake(client);

    const result = (await client.sendRequest('tools/call', {
      name: 'list_guilds',
      arguments: {},
    })) as { content: Array<{ type: string; text?: string }> };

    const text = result.content[0]?.text ?? '';
    assert.ok(text.includes('Test Guild'));

    client.close();
    await serverPromise;
  });

  it('push event from Discord message (non-open channel)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Simulate a Discord message (mentioning the bot so it passes the filter)
    discord.simulateMessage({
      id: 'dm1',
      content: 'Hello agent!',
      cleanContent: 'Hello agent!',
      authorId: 'u1',
      authorName: 'Alice',
      isBot: false,
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      guildName: 'Test Server',
      mentions: ['bot_123'],
      attachments: [],
      timestamp: new Date(),
    });

    // Should receive push/event (channel not open)
    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      assert.equal(pushMsg.request.method, 'push/event');
      const p = pushMsg.request.params as PushEventParams;
      assert.equal(p.featureSet, 'discord.messaging');
      assert.ok(p.payload.content[0].type === 'text');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('first inbound DM carries a reply affordance (send_dm by sender name/id)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Simulate an inbound DM (guildId null → DM; needs no mention to forward).
    discord.simulateMessage({
      id: 'dmmsg1',
      content: 'hey, can you help?',
      cleanContent: 'hey, can you help?',
      authorId: 'u_alice',
      authorName: 'Alice',
      isBot: false,
      channelId: 'dmchan1',
      channelName: undefined,
      guildId: null,
      guildName: undefined,
      mentions: [],
      attachments: [],
      timestamp: new Date(),
    } as unknown as DiscordMessageData);

    const pushMsg = await client.nextMessage();
    assert.equal(pushMsg.type, 'request');
    if (pushMsg.type === 'request') {
      assert.equal(pushMsg.request.method, 'push/event');
      const p = pushMsg.request.params as PushEventParams;
      const text = (p.payload.content[0] as { text?: string }).text ?? '';
      // The bare body is still there…
      assert.ok(text.includes('Alice: hey, can you help?'), 'DM body should render the sender');
      // …plus an explicit, in-context reply affordance so the agent knows it can
      // reply by name/id rather than needing the bot's own user id (the complaint).
      assert.ok(text.includes('Direct message from @Alice'), 'DM should announce the sender');
      assert.ok(text.includes('send_dm("Alice")'), 'DM should suggest replying by sender name');
      assert.ok(text.includes('send_dm("u_alice")'), 'DM should offer the id fallback');
      // The chat:dm tags still ride along for the host gate.
      assert.ok(p.tags?.includes('chat:dm'), 'DM should carry the chat:dm tag');
      client.sendResponse(pushMsg.request.id, { accepted: true });
    }

    client.close();
    await serverPromise;
  });

  it('channels/incoming from Discord message (open channel)', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    // Open a channel
    const openResult = (await client.sendRequest(method.CHANNELS_OPEN, {
      type: 'discord',
      address: { guildId: 'g1', channelId: 'c1' },
    })) as ChannelsOpenResult;
    assert.ok(openResult.channel.id.includes('c1'));

    // Simulate a Discord message on the open channel (mentioning bot)
    discord.simulateMessage({
      id: 'dm2',
      content: 'Message on open channel',
      cleanContent: 'Message on open channel',
      authorId: 'u1',
      authorName: 'Bob',
      isBot: false,
      channelId: 'c1',
      channelName: 'general',
      guildId: 'g1',
      guildName: 'Test Server',
      mentions: ['bot_123'],
      attachments: [],
      timestamp: new Date(),
    });

    // Should receive channels/incoming (not push/event)
    const inMsg = await client.nextMessage();
    assert.equal(inMsg.type, 'request');
    if (inMsg.type === 'request') {
      assert.equal(inMsg.request.method, 'channels/incoming');
      const p = inMsg.request.params as ChannelsIncomingParams;
      assert.equal(p.messages.length, 1);
      assert.equal(p.messages[0].author.name, 'Bob');
      client.sendResponse(inMsg.request.id, { results: [{ messageId: 'dm2', accepted: true }] });
    }

    client.close();
    await serverPromise;
  });

  it('channels/publish sends Discord message', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept channel registration
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') {
      client.sendResponse(regMsg.request.id, {});
    }

    const pubResult = (await client.sendRequest(method.CHANNELS_PUBLISH, {
      conversationId: 'conv_1',
      channelId: 'discord:g1:c1',
      content: [{ type: 'text', text: 'Published message!' }],
    })) as ChannelsPublishResult;

    assert.ok(pubResult.delivered);
    assert.equal(discord.sentMessages.length, 1);
    assert.equal(discord.sentMessages[0].content, 'Published message!');

    client.close();
    await serverPromise;
  });

  it('guildCreate registers new guild channels via channels/changed', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    // Accept the initial channel registration.
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // Bot joins a new guild after startup.
    discord.simulateGuildCreate('g2', 'Second Guild', [
      { id: 'c10', name: 'lobby', type: 'text' },
      { id: 'c11', name: 'random', type: 'text' },
    ]);

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 2);
      assert.ok(p.added!.some((d) => d.id === 'discord:g2:c10'));
      assert.ok(p.added!.some((d) => d.id === 'discord:g2:c11'));
    }

    client.close();
    await serverPromise;
  });

  it('channelAvailable registers a newly-permitted channel', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // Bot granted access to a pre-existing private channel in g1.
    discord.simulateChannelAvailable('g1', { id: 'c-private', name: 'secret', type: 'text' });

    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 1);
      assert.equal(p.added![0].id, 'discord:g1:c-private');
    }

    client.close();
    await serverPromise;
  });

  it('refresh_channels registers channels visible after startup', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);

    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    // The bot's view now includes a channel not present at boot.
    discord.getTextChannels = () => [
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c1', name: 'general', type: 'text' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c2', name: 'dev', type: 'text' } },
      { guildId: 'g1', guildName: 'Test Guild', channel: { id: 'c3', name: 'new-room', type: 'text' } },
    ];

    const callP = client.sendRequest('tools/call', {
      name: 'refresh_channels',
      arguments: {},
    });

    // The refresh emits a channels/changed notification for the new channel.
    const changed = await client.nextMessage();
    assert.equal(changed.type, 'notification');
    if (changed.type === 'notification') {
      assert.equal(changed.notification.method, method.CHANNELS_CHANGED);
      const p = changed.notification.params as { added?: Array<{ id: string }> };
      assert.equal(p.added?.length, 1);
      assert.equal(p.added![0].id, 'discord:g1:c3');
    }

    const result = (await callP) as { content: Array<{ type: string; text?: string }> };
    const payload = JSON.parse(result.content[0].text ?? '{}');
    assert.equal(payload.visible, 3);
    assert.equal(payload.added.length, 1);
    assert.equal(payload.added[0].id, 'discord:g1:c3');

    client.close();
    await serverPromise;
  });

  it('reconnect sweep delivers missed mentions with nearby context from a non-subscribed channel', async () => {
    const wmPath = join(tmpdir(), `discord-mcpl-wm-${process.pid}-sweep.json`);
    writeFileSync(wmPath, JSON.stringify({ watermarks: { c1: '100' }, dmChannels: [] }));
    process.env.DISCORD_WATERMARK_FILE = wmPath;
    try {
      const { client, serverConn, discord } = await createTestPair();
      // Two messages arrived while offline: one plain, one @mentioning the bot.
      // Channel c1 is NOT subscribed, so the mention and its bounded vicinity
      // should be delivered, while the mention count remains one.
      const t = new Date();
      discord.historyToReturn = [
        { id: '101', authorId: 'u1', authorName: 'Alice', isBot: false, content: 'just chatting', cleanContent: 'just chatting', attachments: [], mentionsBot: false, timestamp: t },
        { id: '102', authorId: 'u2', authorName: 'Bob', isBot: false, content: '<@bot_123> ping', cleanContent: '@bot ping', attachments: [], mentionsBot: true, timestamp: t },
      ];
      const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
      const serverPromise = server.serve(serverConn);

      await mcplHandshake(client);

      // Accept channel registration.
      const regMsg = await client.nextMessage();
      assert.equal(regMsg.type, 'request');
      if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

      // Next: the catch-up push/event for the missed mention.
      const missed = await client.nextMessage();
      assert.equal(missed.type, 'request');
      if (missed.type === 'request') {
        assert.equal(missed.request.method, method.PUSH_EVENT);
        const p = missed.request.params as PushEventParams;
        assert.equal(p.eventId, 'discord_missed_c1_102');
        const origin = p.origin as Record<string, unknown>;
        assert.equal(origin.isMention, true);
        assert.equal(origin.isDM, false);
        const text = (p.payload.content[0] as { text: string }).text;
        assert.ok(text.includes('count="1"'), 'only one delivered line is a mention');
        assert.ok(text.includes('lines="2"'), 'the nearby context line is included');
        assert.ok(text.includes('reason="mention"'));
        assert.ok(text.includes('Bob'), 'mention author present');
        assert.ok(text.includes('just chatting'), 'nearby non-mention context included');
        client.sendResponse(missed.request.id, {});
      }

      client.close();
      await serverPromise;
    } finally {
      delete process.env.DISCORD_WATERMARK_FILE;
      if (existsSync(wmPath)) unlinkSync(wmPath);
    }
  });

  it('tracks missed ambient after unsubscribe and reports via channel_missed', async () => {
    const { client, serverConn, discord } = await createTestPair();
    const server = new DiscordMcplServer(discord as unknown as DiscordAdapter);
    const serverPromise = server.serve(serverConn);

    await mcplHandshake(client);
    const regMsg = await client.nextMessage();
    if (regMsg.type === 'request') client.sendResponse(regMsg.request.id, {});

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.sendRequest('tools/call', { name, arguments: args })) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = r.content[0]?.text ?? '';
      // Object-returning tools (channel_missed) serialize as JSON; string-
      // returning tools (subscribe/unsubscribe) come through as plain text.
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };

    // Subscribe then unsubscribe c1 — this anchors a missed-ambient tally.
    await call('subscribe_channel', { channelId: 'c1' });
    await call('unsubscribe_channel', { channelId: 'c1' });

    // Ambient message in c1 (not a mention, not a DM, now unsubscribed) → dropped + tallied.
    discord.simulateMessage({
      id: 'm100', content: 'hello world', cleanContent: 'hello world',
      authorId: 'u1', authorName: 'Alice', isBot: false,
      channelId: 'c1', channelName: 'general', guildId: 'g1', guildName: 'Test Server',
      mentions: [], attachments: [], timestamp: new Date(),
    } as DiscordMessageData);
    // Let the floating async message handler run.
    await new Promise((r) => setTimeout(r, 20));

    const missed = await call('channel_missed', { channelId: 'c1' });
    assert.equal(missed.subscribed, false);
    assert.equal(missed.tracked, true);
    assert.equal(missed.missedMessages, 1);
    assert.equal(missed.missedCharacters, 'hello world'.length);

    // Resubscribing clears the tally.
    await call('subscribe_channel', { channelId: 'c1' });
    const after = await call('channel_missed', { channelId: 'c1' });
    assert.equal(after.subscribed, true);
    assert.equal(after.missedMessages, 0);

    client.close();
    await serverPromise;
  });
});

describe('applyMentionCandidates', () => {
  const cands: MentionCandidate[] = [
    { id: 'u_alice', aliases: ['Alice', 'alice_g'], kind: 'user' },
    { id: 'r_mods', aliases: ['Moderators'], kind: 'role' },
    { id: 'u_mods', aliases: ['Moderators'], kind: 'user' }, // name collision w/ role
    { id: 'r_team', aliases: ['Team'], kind: 'role' },
  ];

  it('resolves a role mention to <@&id>', () => {
    assert.equal(applyMentionCandidates('ping @Team please', cands), 'ping <@&r_team> please');
  });

  it('resolves a user mention to <@id>', () => {
    assert.equal(applyMentionCandidates('hi @Alice', cands), 'hi <@u_alice>');
  });

  it('is case-insensitive for roles', () => {
    assert.equal(applyMentionCandidates('@team', cands), '<@&r_team>');
  });

  it('prefers a user over a role on a name collision', () => {
    // Both u_mods (user) and r_mods (role) are named "Moderators" → user wins.
    assert.equal(applyMentionCandidates('@Moderators', cands), '<@u_mods>');
  });

  it('leaves @everyone / @here untouched', () => {
    assert.equal(applyMentionCandidates('@everyone @here', cands), '@everyone @here');
  });

  it('leaves unknown handles untouched', () => {
    assert.equal(applyMentionCandidates('@nobody', cands), '@nobody');
  });

  it('falls through to a role only when no user matches', () => {
    const roleOnly: MentionCandidate[] = [{ id: 'r_x', aliases: ['Ops'], kind: 'role' }];
    assert.equal(applyMentionCandidates('@Ops', roleOnly), '<@&r_x>');
  });

  it('does not resolve when a role name is ambiguous', () => {
    const ambiguous: MentionCandidate[] = [
      { id: 'r_a', aliases: ['Dup'], kind: 'role' },
      { id: 'r_b', aliases: ['Dup'], kind: 'role' },
    ];
    assert.equal(applyMentionCandidates('@Dup', ambiguous), '@Dup');
  });
});
