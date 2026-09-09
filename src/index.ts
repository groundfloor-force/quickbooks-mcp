#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { registerAllTools } from "./register-all-tools.js";

const main = async () => {
  // Create an MCP server
  const server = QuickbooksMCPServer.GetServer();

  // Register every QuickBooks tool. The full list lives in
  // ./register-all-tools.ts so the stdio and HTTP entry points share it.
  registerAllTools(server);

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
