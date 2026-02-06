import { Client, GatewayIntentBits, REST, Routes, Collection } from 'discord.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AirdropService } from './services/airdrop';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

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
  console.log(`Scheduling precise settlement for ${airdropId} in ${durationMs}ms`);
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
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.ts'));

const commands = [];

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
    console.log(`Loaded command: ${command.data.name}`);
  } else {
    console.log(`[WARNING] The command at ${filePath} is missing required properties.`);
  }
}

// Register commands with Discord
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    const data = await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!), {
      body: commands,
    });

    console.log(`Successfully reloaded ${(data as any[]).length} application (/) commands.`);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();

client.once('clientReady', () => {
  console.log(`Bot logged in as ${client.user?.tag}`);

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
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error executing ${interaction.commandName}:`, error);

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
      console.error('Failed to send error message:', replyError);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
