import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { processTree, listeningPids } from "../lib/runtime.mjs";

test("processTree includes the root and a live child", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const tree = processTree(process.pid);
    assert.ok(tree.has(process.pid), "root must be in its own tree");
    assert.ok(tree.has(child.pid), "spawned child must be in the tree");
  } finally {
    child.kill("SIGKILL");
  }
});

test("listeningPids reports the process that owns an in-process listener", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const pids = listeningPids(port);
    assert.ok(pids.includes(process.pid), `expected ${process.pid} in ${pids.join(",")}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("listeningPids is empty for a closed port", async () => {
  const server = createServer();
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(listeningPids(port), []);
});
