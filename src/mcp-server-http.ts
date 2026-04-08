import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClients, registerTools } from "./tools.js";
import { runImport } from "./importCsv.js";
import { runEmbed } from "./embedChunks.js";

const { supabase, openai } = createClients();

function createServer(): McpServer {
  const server = new McpServer({
    name: "fed-mcp",
    version: "0.0.1",
  });
  registerTools(server, supabase, openai);
  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

let ingestRunning = false;

app.post("/ingest", async (_req, res) => {
  if (ingestRunning) {
    res.status(409).json({ status: "already_running" });
    return;
  }

  ingestRunning = true;
  const startTime = Date.now();

  try {
    console.log("[ingest] starting...");
    const importResult = await runImport();
    const embedResult = await runEmbed();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`[ingest] completed in ${duration}s`);
    res.json({
      status: "ok",
      duration_seconds: parseFloat(duration),
      import: importResult,
      embed: embedResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[ingest] failed:", message);
    res.status(500).json({ status: "error", error: message });
  } finally {
    ingestRunning = false;
  }
});

const port = parseInt(process.env.PORT || "3000", 10);
app.listen(port, "0.0.0.0", () => {
  console.log(`[fed-mcp] listening on port ${port}`);

  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  async function scheduledIngest() {
    if (ingestRunning) return;
    ingestRunning = true;
    try {
      console.log("[cron] starting daily ingest...");
      const importResult = await runImport();
      const embedResult = await runEmbed();
      console.log(`[cron] done — imported ${importResult.inserted} new docs, embedded ${embedResult.embedded} chunks`);
    } catch (error) {
      console.error("[cron] ingest failed:", error);
    } finally {
      ingestRunning = false;
    }
  }

  setInterval(scheduledIngest, TWENTY_FOUR_HOURS);
  console.log("[cron] daily ingest scheduled");
});
