const t0 = Date.now();

function stamp(): string {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6, ' ');
  return `[${s}s]`;
}

export const log = {
  info: (...a: unknown[]) => console.log(stamp(), ...a),
  step: (...a: unknown[]) => console.log(`\n${stamp()} ▸`, ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), '⚠ ', ...a),
  error: (...a: unknown[]) => console.error(stamp(), '✗ ', ...a),
  ok: (...a: unknown[]) => console.log(stamp(), '✓ ', ...a),
};

/** 原地刷新的进度行。非 TTY 环境降级为每 10% 打一行。 */
export function progress(label: string, total: number) {
  let done = 0;
  let lastPct = -1;
  const tty = process.stdout.isTTY;
  return {
    tick(note = '') {
      done++;
      const pct = Math.floor((done / total) * 100);
      if (tty) {
        process.stdout.write(`\r${stamp()} ${label} ${done}/${total} (${pct}%) ${note}`.padEnd(100).slice(0, 100));
      } else if (pct >= lastPct + 10) {
        lastPct = pct - (pct % 10);
        console.log(`${stamp()} ${label} ${done}/${total} (${pct}%)`);
      }
    },
    done() {
      if (tty) process.stdout.write('\n');
    },
  };
}
