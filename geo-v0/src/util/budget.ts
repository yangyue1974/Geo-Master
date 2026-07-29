import { log } from './log.js';

export class BudgetExceeded extends Error {
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`Budget exceeded: $${spentUsd.toFixed(4)} / $${limitUsd.toFixed(2)}`);
    this.name = 'BudgetExceeded';
  }
}

/**
 * 成本护栏。
 *
 * OpenRouter 只有在请求里显式带 `usage: {include: true}` 时才回传真实 cost;
 * 没拿到 cost 的调用按 fallbackPerCall 估算,避免护栏被静默绕过。
 */
export class Budget {
  private spent = 0;
  private unpriced = 0;

  constructor(
    readonly limitUsd: number,
    private readonly fallbackPerCall = 0.02,
  ) {}

  add(costUsd: number | undefined): void {
    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) {
      this.spent += costUsd;
    } else {
      this.unpriced++;
      this.spent += this.fallbackPerCall;
    }
  }

  get total(): number {
    return this.spent;
  }

  get unpricedCalls(): number {
    return this.unpriced;
  }

  /** 超限时抛 BudgetExceeded —— 调用方负责保存已完成进度后再退出。 */
  assert(): void {
    if (this.spent >= this.limitUsd) throw new BudgetExceeded(this.spent, this.limitUsd);
  }

  /** 到 80% 提醒一次,给人留反应时间。 */
  private warned = false;
  checkWarn(): void {
    if (!this.warned && this.spent >= this.limitUsd * 0.8) {
      this.warned = true;
      log.warn(
        `预算已用 ${((this.spent / this.limitUsd) * 100).toFixed(0)}% ($${this.spent.toFixed(2)}/$${this.limitUsd.toFixed(2)})`,
      );
    }
  }
}
