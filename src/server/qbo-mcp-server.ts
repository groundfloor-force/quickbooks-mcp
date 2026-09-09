import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class QuickbooksMCPServer {
  private static instance: McpServer | null = null;

  private constructor() {}

  /**
   * Builds a NEW, unconnected McpServer.
   *
   * An McpServer can only be connected to one transport — Protocol.connect()
   * throws "Already connected to a transport" on a second call — so the HTTP
   * entry point needs a fresh instance per session rather than the shared
   * singleton below. Keeping the name/version/capabilities here means both
   * entry points still describe the server identically.
   */
  public static NewServer(): McpServer {
    return new McpServer(
      {
        name: "QuickBooks Online MCP Server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  }

  public static GetServer(): McpServer {
    if (QuickbooksMCPServer.instance === null) {
      QuickbooksMCPServer.instance = QuickbooksMCPServer.NewServer();
    }
    return QuickbooksMCPServer.instance;
  }
}
