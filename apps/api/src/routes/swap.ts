import { Router } from 'express';
import { prisma } from 'fattips-database';
import { WalletService, JupiterSwapService, PriceService, TOKEN_MINTS } from 'fattips-solana';

const router: Router = Router();

const walletService = new WalletService(process.env.MASTER_ENCRYPTION_KEY!);
const swapService = new JupiterSwapService(process.env.SOLANA_RPC_URL!);
const priceService = new PriceService(process.env.JUPITER_API_URL, process.env.JUPITER_API_KEY);

router.get('/quote', async (req, res) => {
  const inputToken = req.query.inputToken as string;
  const outputToken = req.query.outputToken as string;
  const amount = req.query.amount as string;
  const amountType = (req.query.amountType as string) || 'token';

  try {
    const inputMint = TOKEN_MINTS[inputToken as keyof typeof TOKEN_MINTS];
    const outputMint = TOKEN_MINTS[outputToken as keyof typeof TOKEN_MINTS];

    if (!inputMint || !outputMint) {
      res.status(400).json({ error: 'Invalid token. Use SOL, USDC, or USDT' });
      return;
    }

    let inputAmount = parseFloat(amount);
    if (isNaN(inputAmount) || inputAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    if (amountType === 'usd') {
      const conversion = await priceService.convertUsdToToken(inputAmount, inputMint, inputToken);
      if (!conversion) {
        res.status(400).json({ error: 'Failed to convert USD amount' });
        return;
      }
      inputAmount = conversion.amountToken;
    }

    const quote = await swapService.getQuote(inputMint, outputMint, inputAmount);

    if (!quote) {
      res.status(400).json({ error: 'No route found' });
      return;
    }

    const inputPrice = await priceService.getTokenPrice(inputMint);
    const outputPrice = await priceService.getTokenPrice(outputMint);

    res.json({
      inputToken,
      outputToken,
      inputAmount,
      outputAmount: parseFloat(quote.outAmount),
      priceImpact: parseFloat(quote.priceImpactPct),
      routePlan: quote.routePlan,
      inputUsd: inputPrice ? inputAmount * inputPrice.price : 0,
      outputUsd: outputPrice ? parseFloat(quote.outAmount) * outputPrice.price : 0,
    });
  } catch (error) {
    console.error('Error getting quote:', error);
    res.status(500).json({ error: 'Failed to get quote' });
  }
});

router.post('/execute', async (req, res) => {
  const {
    discordId,
    inputToken,
    outputToken,
    amount,
    amountType = 'token',
    slippageBps = 50,
  } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: discordId },
    });

    if (!user) {
      res.status(404).json({ error: 'User wallet not found' });
      return;
    }

    const inputMint = TOKEN_MINTS[inputToken as keyof typeof TOKEN_MINTS];
    const outputMint = TOKEN_MINTS[outputToken as keyof typeof TOKEN_MINTS];

    if (!inputMint || !outputMint) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }

    let inputAmount = parseFloat(amount);
    if (isNaN(inputAmount) || inputAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    if (amountType === 'usd') {
      const conversion = await priceService.convertUsdToToken(inputAmount, inputMint, inputToken);
      if (!conversion) {
        res.status(400).json({ error: 'Failed to convert USD amount' });
        return;
      }
      inputAmount = conversion.amountToken;
    }

    const quote = await swapService.getQuote(inputMint, outputMint, inputAmount, slippageBps);
    if (!quote) {
      res.status(400).json({ error: 'No route found' });
      return;
    }

    const userKeypair = await walletService.getKeypair(user.encryptedPrivkey, user.keySalt);
    const swapTransaction = await swapService.getSwapTransaction(quote, user.walletPubkey);
    const signature = await swapService.executeSwap(userKeypair, swapTransaction);

    const inputPrice = await priceService.getTokenPrice(inputMint);
    const outputPrice = await priceService.getTokenPrice(outputMint);

    const inputUsd = inputPrice ? inputAmount * inputPrice.price : 0;
    const outputUsd = outputPrice ? parseFloat(quote.outAmount) * outputPrice.price : 0;

    await prisma.transaction.create({
      data: {
        signature,
        fromId: user.discordId,
        amountUsd: inputUsd,
        amountToken: inputAmount,
        tokenMint: inputMint,
        usdRate: inputUsd > 0 ? inputUsd / inputAmount : 0,
        txType: 'DEPOSIT',
        status: 'CONFIRMED',
      },
    });

    res.json({
      success: true,
      signature,
      inputToken,
      outputToken,
      inputAmount,
      outputAmount: parseFloat(quote.outAmount),
      inputUsd,
      outputUsd,
      priceImpact: parseFloat(quote.priceImpactPct),
      solscanUrl: `https://solscan.io/tx/${signature}`,
    });
  } catch (error) {
    console.error('Error executing swap:', error);
    res.status(500).json({ error: 'Failed to execute swap' });
  }
});

router.get('/supported-tokens', async (req, res) => {
  res.json({
    tokens: [
      { symbol: 'SOL', mint: TOKEN_MINTS.SOL, decimals: 9 },
      { symbol: 'USDC', mint: TOKEN_MINTS.USDC, decimals: 6 },
      { symbol: 'USDT', mint: TOKEN_MINTS.USDT, decimals: 6 },
    ],
  });
});

export default router;
