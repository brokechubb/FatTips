import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  DMChannel,
} from 'discord.js';
import { prisma } from 'fattips-database';
import { WalletService, BalanceService, PriceService, TOKEN_MINTS } from 'fattips-solana';

const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const balanceService = new BalanceService(process.env.SOLANA_RPC_URL!);
const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);

export const data = new SlashCommandBuilder()
  .setName('wallet')
  .setDescription('Manage your Solana wallet')
  .setDefaultMemberPermissions(PermissionFlagsBits.UseApplicationCommands)
  .addSubcommand((subcommand) =>
    subcommand.setName('create').setDescription('Create a new Solana wallet')
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('balance').setDescription('Check your wallet balance')
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('export').setDescription('Export your wallet seed phrase (DM only)')
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('address').setDescription('Show your wallet address')
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('clear-dms').setDescription('Delete bot messages in your DM')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case 'create':
      await handleCreate(interaction);
      break;
    case 'balance':
      await handleBalance(interaction);
      break;
    case 'export':
      await handleExport(interaction);
      break;
    case 'address':
      await handleAddress(interaction);
      break;
    case 'clear-dms':
      await handleClearDms(interaction);
      break;
    default:
      await interaction.reply({
        content: 'Unknown subcommand',
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
        content: 'You already have a wallet! Use `/wallet balance` to see your balance.',
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
        .setTitle('🔐 Your FatTips Wallet Seed Phrase')
        .setDescription(
          '**IMPORTANT: Keep this safe!**\n\n' +
            'This is your wallet recovery phrase. Anyone with access to this phrase can access your funds.\n\n' +
            '```\n' +
            wallet.mnemonic +
            '\n```\n\n' +
            '**Tips:**\n' +
            '• Write this down on paper and store it securely\n' +
            '• Never share this with anyone\n' +
            '• You can use this phrase to import your wallet into any Solana wallet app\n\n' +
            '⚠️ **This message will self-destruct in 60 seconds for your security.**'
        )
        .setColor(0xff6b6b)
        .setFooter({ text: 'Auto-deleting in 60s' })
        .setTimestamp();

      const dmMessage = await interaction.user.send({ embeds: [dmEmbed] });

      // Auto-delete after 60 seconds (with edit fallback)
      setTimeout(async () => {
        try {
          // Try to overwrite content first (in case delete fails)
          await dmMessage.edit({
            content: '🔒 Seed phrase removed for security.',
            embeds: [],
          });
          // Then delete
          await dmMessage.delete();
        } catch {
          // Message might already be deleted or channel closed
        }
      }, 60000);

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
          "I couldn't send you a DM with your seed phrase. Please enable DMs from server members and run `/wallet export` to receive your recovery phrase.",
        inline: false,
      });
    } else {
      embed.addFields({
        name: '🔐 Recovery Phrase',
        value: 'Check your DMs for your seed phrase. Keep it safe!',
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // Send public announcement if not in DM
    if (interaction.channel && !(interaction.channel instanceof DMChannel)) {
      // Cast channel to TextChannel to access send()
      // We know it supports send() because it's not a DM and interaction happened there
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

async function handleBalance(interaction: ChatInputCommandInteraction) {
  // Defer immediately - must be within 3 seconds
  const deferPromise = interaction.deferReply({ ephemeral: true });

  try {
    // Wait for defer to complete
    await deferPromise;

    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet. Use `/wallet create` to create one!",
      });
      return;
    }

    // Fetch balances from Solana with timeout
    let balances = { sol: 0, usdc: 0, usdt: 0 };
    try {
      const balancePromise = balanceService.getBalances(user.walletPubkey);
      const timeoutPromise = new Promise<typeof balances>((_, reject) =>
        setTimeout(() => reject(new Error('Balance fetch timeout')), 10000)
      );
      balances = await Promise.race([balancePromise, timeoutPromise]);
    } catch (error) {
      console.error('Error fetching balances from Solana:', error);
      // Continue with zero balances
    }

    // Fetch SOL price for USD calculation
    let solUsdValue = 0;
    let showUsdValues = false;
    try {
      const solPrice = await priceService.getTokenPrice(TOKEN_MINTS.SOL);
      if (solPrice) {
        solUsdValue = balances.sol * solPrice.price;
        showUsdValues = true;
      }
    } catch {
      console.log('Price API unavailable, showing balances without USD values');
    }

    // Format balances
    const solFormatted = BalanceService.formatBalance(balances.sol);
    const usdcFormatted = BalanceService.formatBalance(balances.usdc);
    const usdtFormatted = BalanceService.formatBalance(balances.usdt);

    // Calculate total USD value
    const totalUsd = solUsdValue + balances.usdc + balances.usdt;

    // Build description based on whether we have USD values
    let description = `**Public Address:**\n\`\`\`\n${user.walletPubkey}\n\`\`\``;
    if (showUsdValues) {
      description += `\n\n**Total Value:** $${totalUsd.toFixed(2)} USD`;
    }

    const embed = new EmbedBuilder()
      .setTitle('💰 Your Wallet Balance')
      .setDescription(description)
      .setColor(0x00aaff)
      .addFields(
        {
          name: '☀️ SOL',
          value: showUsdValues ? `${solFormatted} ($${solUsdValue.toFixed(2)})` : solFormatted,
          inline: true,
        },
        { name: '💵 USDC', value: usdcFormatted, inline: true },
        { name: '💶 USDT', value: usdtFormatted, inline: true }
      )
      .setTimestamp();

    // Add total value estimation if we have balances
    const hasBalance = balances.sol > 0 || balances.usdc > 0 || balances.usdt > 0;
    if (hasBalance) {
      embed.addFields({
        name: '💡 Tip',
        value: 'Send `/tip @user $5` to tip someone!',
        inline: false,
      });
    } else {
      embed.addFields({
        name: '💡 Getting Started',
        value: 'Send SOL, USDC, or USDT to your address above to fund your wallet.',
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching balance:', error);
    try {
      await interaction.editReply({
        content: 'Failed to fetch balance. Please try again later.',
      });
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
}

async function handleExport(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    // Check if this is a DM
    if (!(interaction.channel instanceof DMChannel)) {
      await interaction.editReply({
        content:
          '⚠️ For security, you can only export your seed phrase in DMs. Please check your DMs!',
      });

      // Try to initiate DM
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('🔐 Seed Phrase Export')
          .setDescription(
            'You requested to export your wallet seed phrase.\n\n' +
              'Please run `/wallet export` here in this DM to receive your seed phrase securely.'
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
        content: "You don't have a wallet yet. Use `/wallet create` in a server to create one!",
      });
      return;
    }

    // Check if mnemonic is available
    if (!user.encryptedMnemonic || !user.mnemonicSalt) {
      await interaction.editReply({
        content:
          'Unable to export seed phrase. Your wallet may have been created before this feature was available. Please create a new wallet if needed.',
      });
      return;
    }

    // Decrypt the mnemonic
    const mnemonic = walletService.decryptMnemonic(user.encryptedMnemonic, user.mnemonicSalt);

    // Send the mnemonic via DM
    const dmEmbed = new EmbedBuilder()
      .setTitle('🔐 Your Wallet Seed Phrase')
      .setDescription(
        '**IMPORTANT: Keep this safe!**\n\n' +
          'This is your wallet recovery phrase. Anyone with access to this phrase can access your funds.\n\n' +
          '```\n' +
          mnemonic +
          '\n```\n\n' +
          '**Tips:**\n' +
          '• Write this down on paper and store it securely\n' +
          '• Never share this with anyone\n' +
          '• You can use this phrase to import your wallet into any Solana wallet app\n\n' +
          '⚠️ **This message will self-destruct in 60 seconds.**'
      )
      .setColor(0xff6b6b)
      .setFooter({ text: 'Auto-deleting in 60s' })
      .setTimestamp();

    const dmMessage = await interaction.editReply({ embeds: [dmEmbed] });

    // Auto-delete after 60 seconds (with edit fallback)
    setTimeout(async () => {
      try {
        await dmMessage.edit({
          content: '🔒 Seed phrase removed for security.',
          embeds: [],
        });
        await dmMessage.delete();
      } catch {
        // Message might already be deleted
      }
    }, 60000);
  } catch (error) {
    console.error('Error exporting wallet:', error);
    await interaction.editReply({
      content: 'Failed to export wallet. Please try again later.',
    });
  }
}

async function handleAddress(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!user) {
      await interaction.editReply({
        content: "You don't have a wallet yet. Use `/wallet create` to create one!",
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Your Wallet Address')
      .setDescription(`**Public Address:**\n\`\`\`\n${user.walletPubkey}\n\`\`\``)
      .setColor(0x00aaff)
      .addFields({
        name: '💰 Send funds to this address',
        value: 'You can send SOL, USDC, or USDT to this address to fund your wallet.',
        inline: false,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Error fetching address:', error);
    await interaction.editReply({
      content: 'Failed to fetch address. Please try again later.',
    });
  }
}

async function handleClearDms(interaction: ChatInputCommandInteraction) {
  // Must be in DM to clear DMs
  if (!(interaction.channel instanceof DMChannel)) {
    await interaction.reply({
      content: '❌ This command can only be used in DMs with the bot.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel = interaction.channel;

    // Fetch last 100 messages (limit)
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
