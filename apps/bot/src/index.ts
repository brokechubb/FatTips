import { Client, GatewayIntentBits, REST, Routes, Collection } from 'discord.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { AirdropService } from './services/airdrop';
import { logger } from './utils/logger';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [nodeProfilingIntegration()],
    // Performance Monitoring
    tracesSampleRate: 1.0, // Capture 100% of transactions in development
    // Set sampling rate for profiling - this is relative to tracesSampleRate
    profilesSampleRate: 1.0,
    environment: process.env.NODE_ENV || 'development',
  });
  logger.info('Sentry initialized successfully');
}

const airdropService = new AirdropService();

// Extend Client to include commands collection
declare module 'discord.js' {
  interface Client {
    commands: Collection<string, any>;
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

// Custom event for short airdrops
client.on('scheduleAirdrop', (airdropId: string, durationMs: number) => {
  logger.info(`Scheduling precise settlement for ${airdropId} in ${durationMs}ms`);
  setTimeout(() => {
    // Re-fetch client to be safe, though closure captures it
    // We need to fetch the airdrop object first since settleAirdrop expects it
    // Actually, settleExpiredAirdrops finds it.
    // We should expose a method to settle specific ID.
    airdropService.settleAirdropById(airdropId, client);
  }, durationMs);
});

// Store commands in a collection
client.commands = new Collection();

// Load commands
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts'));

const commands = [];

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
    logger.info(`Loaded command: ${command.data.name}`);
  } else {
    logger.warn(`The command at ${filePath} is missing required properties.`);
  }
}

// Register commands with Discord
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

(async () => {
  try {
    logger.info(`Started refreshing ${commands.length} application (/) commands.`);

    const data = await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), {
      body: commands,
    });

    logger.info(`Successfully reloaded ${(data as any[]).length} application (/) commands.`);
  } catch (error) {
    logger.error('Error registering commands:', error);
    Sentry.captureException(error);
  }
})();

client.once('clientReady', () => {
  logger.info(`Bot logged in as ${client.user?.tag}`);

  // Schedule airdrop settlement (every 10 seconds for responsiveness)
  setInterval(() => {
    airdropService.settleExpiredAirdrops(client);
  }, 10 * 1000);
});

client.on('interactionCreate', async (interaction) => {
  // Handle Buttons
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('claim_airdrop_')) {
      const airdropId = interaction.customId.replace('claim_airdrop_', '');
      await airdropService.handleClaim(interaction, airdropId);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Error executing ${interaction.commandName}:`, error);

    // Capture error in Sentry with context
    Sentry.captureException(error, {
      tags: {
        command: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guild?.id,
      },
    });

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'There was an error while executing this command!',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: 'There was an error while executing this command!',
          ephemeral: true,
        });
      }
    } catch (replyError) {
      logger.error('Failed to send error message:', replyError);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
