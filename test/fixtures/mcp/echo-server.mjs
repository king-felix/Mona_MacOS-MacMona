#!/usr/bin/env node
// Minimal MCP stdio server fixture for Mona P17 verification.
// Newline-delimited JSON-RPC 2.0. No network, no shell, no credentials.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

const TOOLS = [
  {
    name: "echo",
    description: "Echo the provided text back. Local fixture only.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mona-fixture", version: "0.1.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    const text = String(message.params?.arguments?.text ?? "");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: `echo: ${text}` }], isError: false },
    });
    return;
  }
  if (typeof message.id === "number" || typeof message.id === "string") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `method not found: ${message.method}` },
    });
  }
});
