import { Connection } from '@solana/web3.js';

export type NetworkStatus = 'healthy' | 'degraded' | 'congested';

export interface NetworkHealth {
  status: NetworkStatus;
  tps: number;
  priorityFee: number; // microLamports, recommended level
  lastUpdated: Date;
}

// TPS thresholds — non-vote TPS from getRecentPerformanceSamples
// Solana theoretical max is ~65k but real-world sustained is 1k-4k non-vote.
// Low TPS often means the network is struggling to process, not just quiet.
const TPS_DEGRADED_THRESHOLD = 400; // below this → degraded
const TPS_CONGESTED_THRESHOLD = 150; // below this → congested

// Priority fee thresholds in microLamports (recommended level from Helius)
const FEE_DEGRADED_THRESHOLD = 200_000; // above this → degraded
const FEE_CONGESTED_THRESHOLD = 1_000_000; // above this → congested

const POLL_INTERVAL_MS = 30_000; // poll every 30s
const PERFORMANCE_SAMPLES = 4; // average over ~4 samples (~2 min window)

export class NetworkMonitor {
  private connection: Connection;
  private rpcUrl: string;
  private health: NetworkHealth;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    // Start with a neutral baseline until first poll completes
    this.health = {
      status: 'healthy',
      tps: 0,
      priorityFee: 0,
      lastUpdated: new Date(0),
    };
  }

  /**
   * Start polling. Runs an immediate poll then repeats every 30s.
   */
  start(): void {
    this.poll().catch(() => {});
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getHealth(): NetworkHealth {
    return this.health;
  }

  getStatus(): NetworkStatus {
    return this.health.status;
  }

  /**
   * Returns a short human-readable status string for Discord presence.
   * e.g. "Network: healthy | 1,240 TPS"
   */
  getPresenceText(): string {
    const { status, tps } = this.health;
    const tpsStr = tps > 0 ? ` | ${tps.toLocaleString()} TPS` : '';
    const emoji = status === 'healthy' ? '✅' : status === 'degraded' ? '⚠️' : '🔴';
    return `${emoji} Network: ${status}${tpsStr}`;
  }

  /**
   * Returns an inline warning string to prepend to command responses when
   * the network is not healthy. Returns null when healthy.
   */
  getWarningText(): string | null {
    const { status, tps, priorityFee } = this.health;
    if (status === 'healthy') return null;

    const feeStr = priorityFee > 0 ? ` (priority fee ~${(priorityFee / 1000).toFixed(0)}k µL)` : '';
    const tpsStr = tps > 0 ? `, ~${tps.toLocaleString()} TPS` : '';

    if (status === 'congested') {
      return `⚠️ **Solana is heavily congested right now**${tpsStr}${feeStr}. Your transaction will be submitted with a boosted priority fee, but delays or failures are possible. You can check https://solanabeach.io for live network status.`;
    }
    return `⚠️ **Solana network is slightly degraded right now**${tpsStr}${feeStr}. Transactions may take a little longer than usual.`;
  }

  private async poll(): Promise<void> {
    try {
      const [tps, priorityFee] = await Promise.all([this.fetchTps(), this.fetchRecommendedFee()]);

      const status = this.classify(tps, priorityFee);

      this.health = { status, tps, priorityFee, lastUpdated: new Date() };
    } catch (err) {
      // Don't crash — keep last known health
      console.warn('[NetworkMonitor] Poll failed:', err);
    }
  }

  private async fetchTps(): Promise<number> {
    const samples = await this.connection.getRecentPerformanceSamples(PERFORMANCE_SAMPLES);
    if (!samples.length) return 0;
    // Average non-vote TPS across samples
    const total = samples.reduce((sum, s) => {
      // numNonVoteTransactions is the real user-activity signal; fall back to numTransactions
      const tx =
        (s as unknown as { numNonVoteTransactions?: number }).numNonVoteTransactions ??
        s.numTransactions;
      return sum + tx / s.samplePeriodSecs;
    }, 0);
    return Math.round(total / samples.length);
  }

  private async fetchRecommendedFee(): Promise<number> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'getPriorityFeeEstimate',
          params: [{ options: { recommended: true } }],
        }),
      });
      const data = (await response.json()) as {
        result?: { priorityFeeEstimate?: number };
      };
      return data?.result?.priorityFeeEstimate ?? 0;
    } catch {
      return 0;
    }
  }

  private classify(tps: number, priorityFee: number): NetworkStatus {
    // Either signal being bad is enough to flag the network
    if (tps > 0 && tps < TPS_CONGESTED_THRESHOLD) return 'congested';
    if (priorityFee > FEE_CONGESTED_THRESHOLD) return 'congested';
    if (tps > 0 && tps < TPS_DEGRADED_THRESHOLD) return 'degraded';
    if (priorityFee > FEE_DEGRADED_THRESHOLD) return 'degraded';
    return 'healthy';
  }
}
