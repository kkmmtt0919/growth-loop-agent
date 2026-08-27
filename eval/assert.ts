/**
 * eval 用例共享断言工具（零依赖）。
 * 断言失败抛 Error，由 run.ts 捕获并记入 failures。
 */

export function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
  }
}

export function assertDeepEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg}（期望 ${b}，实际 ${a}）`);
  }
}
