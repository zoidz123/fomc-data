import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClients, registerTools } from "./tools.js";

const { supabase, openai } = createClients();

const server = new McpServer({
  name: "fed-mcp",
  version: "0.0.1",
});

registerTools(server, supabase, openai);

const transport = new StdioServerTransport();
await server.connect(transport);
