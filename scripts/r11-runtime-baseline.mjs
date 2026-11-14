// R11 — the runtime's own memory floor.
//
// The specification's target is "initial idle total Mona processes target under
// 350 MiB". Before an application can be held to that number, the runtime it
// runs on has to fit inside it: a window whose only content is an `<h1>` costs
// the Electron framework, its GPU process, its network-utility process and a
// renderer, and none of that is Mona's code.
//
// This measures that floor on this host, so the application's own share can be
// reported as a difference rather than as an excuse. It starts no Mona code and
// makes no network request.
// This file is copied into a scratch directory and run as an Electron app entry
// point, which Electron loads as CommonJS; an ESM import is not available there.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true });
  await win.loadURL("data:text/html,<h1>runtime baseline</h1>");
  // The same warm-up the application run gets.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const samples = [];
  for (let index = 0; index < 10; index += 1) {
    const metrics = app.getAppMetrics();
    samples.push({
      totalMb: metrics.reduce((sum, entry) => sum + (entry.memory?.workingSetSize ?? 0), 0) / 1024,
      processes: metrics.length,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const metrics = app.getAppMetrics();
  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      total_mb_max: Math.round(Math.max(...samples.map((entry) => entry.totalMb))),
      total_mb_min: Math.round(Math.min(...samples.map((entry) => entry.totalMb))),
      per_process: metrics.map((entry) => ({
        type: entry.type,
        memoryMb: Math.round(((entry.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
      })),
    }),
  );
  app.quit();
});
