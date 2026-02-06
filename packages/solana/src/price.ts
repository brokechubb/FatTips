// Jupiter Price API V3 integration for USD to token conversion
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v3';

export interface TokenPrice {
  price: number;
  mint: string;
  symbol: string;
}

export interface ConversionResult {
  amountToken: number;
  tokenSymbol: string;
  tokenMint: string;
  usdValue: number;
  price: number;
}

export class JupiterPriceService {
  private apiUrl: string;
  private apiKey?: string;

  constructor(apiUrl?: string, apiKey?: string) {
    this.apiUrl = apiUrl || JUPITER_PRICE_API;
    this.apiKey = apiKey;
  }

  /**
   * Get token price in USD
   */
  async getTokenPrice(mintAddress: string): Promise<TokenPrice | null> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      const response = await fetch(`${this.apiUrl}?ids=${mintAddress}`, { headers });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as Record<string, { usdPrice?: number; price?: string }>;

      // Check for direct format (V3 Stable)
      if (data[mintAddress]) {
        const tokenData = data[mintAddress];
        const price = tokenData.usdPrice ?? parseFloat(tokenData.price || '0');

        return {
          price,
          mint: mintAddress,
          symbol: this.getSymbolFromMint(mintAddress),
        };
      }

      // Check for wrapped format (V3 Beta / Old V4)
      const wrappedData = data as unknown as { data: Record<string, { price: string }> };
      if (wrappedData.data && wrappedData.data[mintAddress]) {
        return {
          price: parseFloat(wrappedData.data[mintAddress].price),
          mint: mintAddress,
          symbol: this.getSymbolFromMint(mintAddress),
        };
      }

      return null;
    } catch (error) {
      console.error('API Error:', error);
      // Silently return null - API might require key or be unavailable
      return null;
    }
  }

  /**
   * Convert USD amount to token amount
   */
  async convertUsdToToken(
    usdAmount: number,
    mintAddress: string,
    tokenSymbol: string
  ): Promise<ConversionResult | null> {
    const price = await this.getTokenPrice(mintAddress);

    if (!price || price.price <= 0) {
      return null;
    }

    const amountToken = usdAmount / price.price;

    return {
      amountToken,
      tokenSymbol,
      tokenMint: mintAddress,
      usdValue: usdAmount,
      price: price.price,
    };
  }

  /**
   * Get prices for all supported tokens
   */
  async getAllTokenPrices(mintAddresses: string[]): Promise<Map<string, TokenPrice>> {
    const prices = new Map<string, TokenPrice>();

    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['x-api-key'] = this.apiKey;
      }

      const ids = mintAddresses.join(',');
      const response = await fetch(`${this.apiUrl}?ids=${ids}`, { headers });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as {
        data?: Record<
          string,
          {
            id: string;
            price: string;
            type?: string;
          }
        >;
      };

      if (data.data) {
        for (const [mint, info] of Object.entries(data.data)) {
          prices.set(mint, {
            price: parseFloat(info.price),
            mint,
            symbol: this.getSymbolFromMint(mint),
          });
        }
      }
    } catch (error) {
      console.error('Error fetching token prices:', error);
    }

    return prices;
  }

  /**
   * Get token symbol from mint address
   */
  private getSymbolFromMint(mint: string): string {
    const symbolMap: Record<string, string> = {
      [TOKEN_MINTS.SOL]: 'SOL',
      [TOKEN_MINTS.USDC]: 'USDC',
      [TOKEN_MINTS.USDT]: 'USDT',
    };
    return symbolMap[mint] || 'UNKNOWN';
  }
}

// Token mint addresses
export const TOKEN_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

export { JupiterPriceService as PriceService };
