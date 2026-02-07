import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  DMChannel,
  InteractionContextType,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { WalletService } from 'fattips-solana';

const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);

export const data = new SlashCommandBuilder()
  .setName('wallet')
  .setDescription('Manage your Solana wallet settings')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .addStringOption((option) =>
    option
      .setName('action')
      .setDescription('Select an action')
      .setRequired(true)
      .addChoices(
        { name: 'Create Wallet', value: 'create' },
        { name: 'Export Recovery Phrase (BIP39)', value: 'export' },
        { name: 'Export Private Key', value: 'export-key' },
        { name: 'Clear DM History', value: 'clear-dms' }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const action = interaction.options.getString('action', true);

  switch (action) {
    case 'create':
      await handleCreate(interaction);
      break;
    case 'export':
      await handleExport(interaction);
      break;
    case 'export-key':
      await handleExportKey(interaction);
      break;
    case 'clear-dms':
      await handleClearDms(interaction);
      break;
    default:
      await interaction.reply({
        content: 'Unknown action',
        ephemeral: true,
      });
  }
}

async function handleCreate(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    // Check if user already has a wallet
    const existingUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (existingUser) {
      await interaction.editReply({
        content: 'You already have a wallet! Use `/balance` to see your balance.',
      });
      return;
    }

    // Generate new wallet
    const wallet = walletService.createEncryptedWallet();

    // Save to database
    await prisma.user.create({
      data: {
        discordId: interaction.user.id,
        walletPubkey: wallet.publicKey,
        encryptedPrivkey: wallet.encryptedPrivateKey,
        keySalt: wallet.keySalt,
        encryptedMnemonic: wallet.encryptedMnemonic,
        mnemonicSalt: wallet.mnemonicSalt,
        seedDelivered: false,
      },
    });

    // Try to DM the seed phrase
    let dmSuccess = false;
    try {
      const dmEmbed = new EmbedBuilder()
        .setTitle('🔐 Your FatTips Wallet Private Key')
        .setDescription(
          '**IMPORTANT: Keep this safe!**\n\n' +
            'This is your wallet private key. Anyone with access to this string can access your funds.\n\n' +
            '```\n' +
            wallet.privateKeyBase58 +
            '\n```\n\n' +
            '**Tips:**\n' +
            '• Write this down or store it in a password manager\n' +
            '• Never share this with anyone\n' +
            '• You can use this key to import your wallet into **Phantom** or **Solflare** (Select "Import Private Key")\n\n' +
            '⚠️ **This message will self-destruct in 15 minutes for your security.**'
        )
        .setColor(0xff6b6b)
        .setFooter({ text: 'Auto-deleting sensitive info in 15m' })
        .setTimestamp();

      const dmMessage = await interaction.user.send({ embeds: [dmEmbed] });

      // Send a separate persistent guide message
      const guideEmbed = new EmbedBuilder()
        .setTitle('🚀 Getting Started with FatTips')
        .setDescription('FatTips is a non-custodial wallet. Here is how to use it:')
        .setColor(0x00aaff)
        .addFields(
          {
            name: '💰 Check Balance',
            value: 'Use `/balance` to see your funds and public address.',
          },
          {
            name: '💸 Send & Tip',
            value: 'Use `/tip @user $5` to tip friends instantly.',
          },
          {
            name: '📤 Withdraw Funds',
            value:
              'Want to move funds to Phantom/Solflare? Use:\n' +
              '`/send <address> all`\n' +
              '(This drains your wallet completely to your external address).',
          },
          {
            name: '🔐 Security',
            value:
              'The private key above allows you to import this wallet anywhere. **It will self-destruct in 15 minutes.** If you miss it, use `/wallet action:export-key` to see it again.',
          }
        );

      await interaction.user.send({ embeds: [guideEmbed] });

      // Auto-remove private key after 15 minutes
      setTimeout(async () => {
        try {
          await dmMessage.edit({
            content:
              '🔒 **Private key removed for security.**\nUse `/wallet action:export-key` to view it again.',
            embeds: [],
          });
        } catch {
          // Message might already be deleted or channel closed
        }
      }, 900000); // 15 minutes

      dmSuccess = true;

      // Update seed delivered status
      await prisma.user.update({
        where: { discordId: interaction.user.id },
        data: { seedDelivered: true },
      });
    } catch (dmError) {
      console.error('Failed to send DM:', dmError);
    }

    // Send confirmation in channel
    const embed = new EmbedBuilder()
      .setTitle('✅ Wallet Created Successfully')
      .setDescription(
        'Your Solana wallet has been created!\n\n' +
          `**Public Address:**\n\`\`\`\n${wallet.publicKey}\n\`\`\``
      )
      .setColor(0x00ff00)
      .addFields({
        name: '💰 Funding Your Wallet',
        value: 'Send SOL, USDC, or USDT to the address above to start tipping!',
        inline: false,
      })
      .setTimestamp();

    if (!dmSuccess) {
      embed.addFields({
        name: '⚠️ Important',
        value:
          "I couldn't send you a DM with your private key. Please enable DMs from server members and run `/wallet action:export-key` to receive your private key.",
        inline: false,
      });
    } else {
      embed.addFields({
        name: '🔐 Private Key',
        value: 'Check your DMs for your private key. Keep it safe!',
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // Send public announcement if not in DM
    if (interaction.channel && !(interaction.channel instanceof DMChannel)) {
      const channel = interaction.channel as any;
      if (typeof channel.send === 'function') {
        await channel.send({
          content: `🎉 ${interaction.user} just created a Solana wallet with FatTips!`,
        });
      }
    }
  } catch (error) {
    console.error('Error creating wallet:', error);
    await interaction.editReply({
      content: 'Failed to create wallet. Please try again later.',
    });
  }
}

async function handleExport(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    // Check if this is a DM (interaction.guild is null in DMs)
    if (interaction.guild) {
      await interaction.editReply({
        content:
          '⚠️ For security, you can only export your recovery phrase in DMs. Please check your DMs!',
      });

      // Try to initiate DM
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('🔐 Recovery Phrase Export')
          .setDescription(
            'You requested to export your wallet recovery phrase.\n\n' +
              'Please run `/wallet action:export` here in this DM to receive your recovery phrase securely.'
          )
          .setColor(0xffaa00);

        await interaction.user.send({ embeds: [dmEmbed] });
      } catch {
        await interaction.editReply({
          content: "I couldn't send you a DM. Please enable DMs from server members and try again.",
        });
      }
      return;
    }

    // In DM channel, proceed with export
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content:
          "You don't have a wallet yet. Use `/wallet action:create` in a server to create one!",
      });
      return;
    }

    // Check if mnemonic is available
    if (!user.encryptedMnemonic || !user.mnemonicSalt) {
      await interaction.editReply({
        content:
          'Unable to export recovery phrase. Your wallet may have been created before this feature was available. Please create a new wallet if needed.',
      });
      return;
    }

    // Decrypt the mnemonic
    const mnemonic = walletService.decryptMnemonic(user.encryptedMnemonic, user.mnemonicSalt);

    // Send the mnemonic via DM
    const dmEmbed = new EmbedBuilder()
      .setTitle('🔐 Your Wallet Recovery Phrase')
      .setDescription(
        '**IMPORTANT: Keep this safe!**\n\n' +
          'This is your wallet recovery phrase. Anyone with access to this phrase can access your funds.\n\n' +
          '```\n' +
          mnemonic +
          '\n```\n\n' +
          '**Tips:**\n' +
          '• Write this down on paper and store it securely\n' +
          '• Never share this with anyone\n' +
          '• **Note:** Some wallets (Phantom/Solflare) may derive a different address from this phrase. Use `/wallet action:export-key` for an exact match.\n\n' +
          '⚠️ **This message will self-destruct in 15 minutes.**'
      )
      .setColor(0xff6b6b)
      .setFooter({ text: 'Auto-deleting sensitive info in 15m' })
      .setTimestamp();

    const dmMessage = await interaction.editReply({ embeds: [dmEmbed] });

    // Auto-remove recovery phrase after 15 minutes
    setTimeout(async () => {
      try {
        await dmMessage.edit({
          content:
            '🔒 **Recovery phrase removed for security.**\nUse `/wallet action:export` to view it again.',
          embeds: [],
        });
      } catch {
        // Message might already be deleted
      }
    }, 900000); // 15 minutes
  } catch (error) {
    console.error('Error exporting wallet:', error);
    await interaction.editReply({
      content: 'Failed to export wallet. Please try again later.',
    });
  }
}

async function handleExportKey(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    // Check if this is a DM (interaction.guild is null in DMs)
    if (interaction.guild) {
      await interaction.editReply({
        content:
          '⚠️ For security, you can only export your private key in DMs. Please check your DMs!',
      });

      // Try to initiate DM
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('🔐 Private Key Export')
          .setDescription(
            'You requested to export your wallet private key.\n\n' +
              'Please run `/wallet action:export-key` here in this DM to receive it securely.'
          )
          .setColor(0xffaa00);

        await interaction.user.send({ embeds: [dmEmbed] });
      } catch {
        await interaction.editReply({
          content: "I couldn't send you a DM. Please enable DMs from server members and try again.",
        });
      }
      return;
    }

    // In DM channel, proceed with export
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content:
          "You don't have a wallet yet. Use `/wallet action:create` in a server to create one!",
      });
      return;
    }

    // Decrypt the private key
    const privateKeyBase58 = walletService.exportPrivateKey(user.encryptedPrivkey, user.keySalt);

    // Send the private key via DM
    const dmEmbed = new EmbedBuilder()
      .setTitle('🔑 Your Wallet Private Key')
      .setDescription(
        '**IMPORTANT: Keep this safe!**\n\n' +
          'This is your raw private key. Anyone with access to this can access your funds.\n\n' +
          '```\n' +
          privateKeyBase58 +
          '\n```\n\n' +
          '**Tips:**\n' +
          '• Never share this with anyone\n' +
          '• You can import this into Phantom/Solflare using "Import Private Key"\n\n' +
          '⚠️ **This message will self-destruct in 15 minutes.**'
      )
      .setColor(0xff0000) // Red for danger
      .setFooter({ text: 'Auto-deleting sensitive info in 15m' })
      .setTimestamp();

    const dmMessage = await interaction.editReply({ embeds: [dmEmbed] });

    // Auto-delete after 15 minutes (with edit fallback)
    setTimeout(async () => {
      try {
        await dmMessage.edit({
          content:
            '🔒 **Private key removed for security.**\nUse `/wallet action:export-key` to view it again.',
          embeds: [],
        });
      } catch {
        // Message might already be deleted
      }
    }, 900000); // 15 minutes
  } catch (error) {
    console.error('Error exporting private key:', error);
    await interaction.editReply({
      content: 'Failed to export private key. Please try again later.',
    });
  }
}

async function handleClearDms(interaction: ChatInputCommandInteraction) {
  // Must be in DM to clear DMs (interaction.guild is null in DMs)
  if (interaction.guild) {
    await interaction.reply({
      content: '❌ This command can only be used in DMs with the bot.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // In DMs, we need to fetch the channel if it's partial or use interaction.user.createDM()
    const channel = interaction.channel || (await interaction.user.createDM());

    // Fetch last 100 messages (limit)
    // Note: DMs are not guaranteed to support bulk delete, so we fetch and delete individually
    const messages = await channel.messages.fetch({ limit: 100 });

    // Filter messages sent by the bot
    const botMessages = messages.filter(
      (msg) => msg.author.id === interaction.client.user.id && !msg.system
    );

    if (botMessages.size === 0) {
      await interaction.editReply({ content: '✅ No bot messages found to clear.' });
      return;
    }

    // Delete them
    let deletedCount = 0;
    for (const msg of botMessages.values()) {
      try {
        await msg.delete();
        deletedCount++;
      } catch {
        // Ignore if already deleted or too old (though in DMs usually fine)
      }
    }

    await interaction.editReply({
      content: `✅ Cleared ${deletedCount} messages from our DM history.`,
    });
  } catch (error) {
    console.error('Error clearing DMs:', error);
    await interaction.editReply({
      content: 'Failed to clear DMs. Please try again later.',
    });
  }
}
