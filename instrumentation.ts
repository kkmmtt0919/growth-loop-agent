/**
 * Next.js instrumentation（根目录约定，见 node_modules/next/dist/docs/01-app/02-guides/instrumentation.md）。
 * 在服务器实例启动时挂载晚报调度器（仅 Node.js runtime；Edge 不加载）。
 * 调度器为 MVP 实现（常驻进程 setInterval）；serverless 部署改用 CRON_SECRET 外部触发。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startEveningScheduler } = await import("./lib/scheduler");
    startEveningScheduler();
  }
}
