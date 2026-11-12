/**
 * Bounded restart policy for an owned runtime *process*. Restart never
 * resubmits a turn and never spends inference; that is a separate reconciled
 * decision made by the caller.
 */
export interface RestartDecision {
  restart: boolean;
  delayMs: number;
  attempt: number;
  /** Present when the policy declined to restart. */
  reason: "bounded_restart" | "restart_exhausted" | "unexpected_clean_exit" | "disabled";
}

export interface RestartPolicyOptions {
  maxRestarts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A run that stays up this long resets the consecutive-crash count. */
  stableUptimeMs?: number;
}

export class RestartPolicy {
  private readonly maxRestarts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly stableUptimeMs: number;
  private attempts = 0;
  private startedAt: number | null = null;

  constructor(
    options: RestartPolicyOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.maxRestarts = options.maxRestarts ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 8_000;
    this.stableUptimeMs = options.stableUptimeMs ?? 60_000;
  }

  noteStarted(): void {
    this.startedAt = this.now();
  }

  /** Call when a run ends; resets the count only after a demonstrably stable run. */
  noteExit(clean: boolean): RestartDecision {
    const uptime = this.startedAt === null ? 0 : this.now() - this.startedAt;
    if (uptime >= this.stableUptimeMs) this.attempts = 0;
    this.startedAt = null;
    if (clean) {
      return {
        restart: false,
        delayMs: 0,
        attempt: this.attempts,
        reason: "unexpected_clean_exit",
      };
    }
    if (this.attempts >= this.maxRestarts) {
      return {
        restart: false,
        delayMs: 0,
        attempt: this.attempts,
        reason: "restart_exhausted",
      };
    }
    const attempt = this.attempts;
    this.attempts += 1;
    const delayMs = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    return { restart: true, delayMs, attempt: attempt + 1, reason: "bounded_restart" };
  }

  reset(): void {
    this.attempts = 0;
    this.startedAt = null;
  }

  snapshot(): { attempts: number; startedAt: number | null; maxRestarts: number } {
    return { attempts: this.attempts, startedAt: this.startedAt, maxRestarts: this.maxRestarts };
  }
}
