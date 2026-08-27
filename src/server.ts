import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRillMcpServer,
  createSessionFromEnv,
} from "./register-tools.js";

export async function startStdioServer(): Promise<void> {
  const session = createSessionFromEnv();
  const server = createRillMcpServer(session, "stdio", "full");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
