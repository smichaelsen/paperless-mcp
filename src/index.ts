#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { PaperlessAPI } from "./api/PaperlessAPI";
import {
  resolvePaperlessToken,
  TOKEN_ENV,
  TOKEN_FILE_ENV,
} from "./config/credentials";
import { logFatal, registerSecret } from "./logging";
import { registerCorrespondentTools } from "./tools/correspondents";
import { registerDocumentTools } from "./tools/documents";
import { registerDocumentTypeTools } from "./tools/documentTypes";
import { registerTagTools } from "./tools/tags";

// Simple CLI argument parsing
const args = process.argv.slice(2);
const useHttp = args.includes("--http");
let port = 3000;
const portIndex = args.indexOf("--port");
if (portIndex !== -1 && args[portIndex + 1]) {
  const parsed = parseInt(args[portIndex + 1], 10);
  if (!isNaN(parsed)) port = parsed;
}

async function main() {
  let baseUrl: string | undefined;
  let token: string | undefined;

  const envHint = `PAPERLESS_URL and ${TOKEN_ENV} (or ${TOKEN_FILE_ENV}) environment variables must be set.`;

  if (useHttp) {
    baseUrl = process.env.PAPERLESS_URL;
    token = resolvePaperlessToken(process.env)?.value;
    if (!baseUrl || !token) {
      console.error(`When using --http, ${envHint}`);
      process.exit(1);
    }
  } else {
    baseUrl = args[0] || process.env.PAPERLESS_URL;
    // Resolved lazily: a positional token wins, and `||` short-circuits, so a
    // stale or unmounted PAPERLESS_API_TOKEN_FILE in the environment cannot
    // break the documented `paperless-mcp <baseUrl> <token>` form.
    token = args[1] || resolvePaperlessToken(process.env)?.value;
    if (!baseUrl || !token) {
      console.error(
        "Usage: paperless-mcp <baseUrl> <token> [--http] [--port <port>]"
      );
      console.error(
        "Example: paperless-mcp http://localhost:8000 your-api-token --http --port 3000"
      );
      console.error(`Alternatively, ${envHint}`);
      process.exit(1);
    }
  }

  registerSecret(token);

  // Initialize API client and server once
  const api = new PaperlessAPI(baseUrl, token);
  const server = new McpServer({ name: "paperless-ngx", version: "1.0.0" });
  registerDocumentTools(server, api);
  registerTagTools(server, api);
  registerCorrespondentTools(server, api);
  registerDocumentTypeTools(server, api);

  if (useHttp) {
    const app = express();
    app.use(express.json());

    // Store transports for each session
    const sseTransports: Record<string, SSEServerTransport> = {};

    app.post("/mcp", async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => {
          transport.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    app.get("/mcp", async (req, res) => {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    app.delete("/mcp", async (req, res) => {
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed.",
          },
          id: null,
        })
      );
    });

    app.get("/sse", async (req, res) => {
      console.log("SSE request received");
      try {
        const transport = new SSEServerTransport("/messages", res);
        sseTransports[transport.sessionId] = transport;
        res.on("close", () => {
          delete sseTransports[transport.sessionId];
          transport.close();
        });
        await server.connect(transport);
      } catch (error) {
        console.error("Error handling SSE request:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          });
        }
      }
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = sseTransports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No transport found for sessionId");
      }
    });

    app.listen(port, () => {
      console.log(
        `MCP Stateless Streamable HTTP Server listening on port ${port}`
      );
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((e) => {
  // Never print the raw error: its message may embed a credential-bearing URL.
  logFatal(e);
  process.exitCode = 1;
});
