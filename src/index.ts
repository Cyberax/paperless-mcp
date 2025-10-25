#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { RequestHandler } from "express";
import { parseArgs } from "node:util";
import { PaperlessAPI } from "./api/PaperlessAPI";
import { registerCorrespondentTools } from "./tools/correspondents";
import { registerCustomFieldTools } from "./tools/customFields";
import { registerDocumentTools } from "./tools/documents";
import { registerDocumentTypeTools } from "./tools/documentTypes";
import { registerTagTools } from "./tools/tags";
import { ProxyOAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

const {
  values: { baseUrl, token, http: useHttp, port, publicUrl },
} = parseArgs({
  options: {
    baseUrl: { type: "string" },
    token: { type: "string" },
    http: { type: "boolean", default: false },
    port: { type: "string" },
    publicUrl: { type: "string", default: "" },
  },
  allowPositionals: true,
});

const resolvedBaseUrl = baseUrl || process.env.PAPERLESS_URL;
const resolvedToken = token || process.env.PAPERLESS_API_KEY;
const resolvedPublicUrl =
  publicUrl || process.env.PAPERLESS_PUBLIC_URL || resolvedBaseUrl;
const resolvedPort = port ? parseInt(port, 10) : 3000;
const mcpClientId = process.env.MCP_CLIENT_ID || '';
const mcpClientSecret = process.env.MCP_CLIENT_SECRET || '';
const mcpOauthUrl = process.env.MCP_OAUTH_URL || '';
const mcpTokenUrl = process.env.MCP_OAUTH_TOKEN_URL || '';
const mcpPublicHost = process.env.MCP_PUBLIC_HOST || '';
const mcpAllowedUsers = process.env.MCP_ALLOWED_USERS || '';

if (!resolvedBaseUrl || !resolvedToken) {
  console.error(
    "Usage: paperless-mcp --baseUrl <url> --token <token> [--http] [--port <port>] [--publicUrl <url>]"
  );
  console.error(
    "Or set PAPERLESS_URL and PAPERLESS_API_KEY environment variables."
  );
  process.exit(1);
}

async function main() {
  // Initialize API client and server once
  const api = new PaperlessAPI(resolvedBaseUrl!, resolvedToken!);
  const server = new McpServer(
    { name: "paperless-ngx", version: "1.0.0" },
    {
      instructions: `
Paperless-NGX MCP Server Instructions

⚠️ CRITICAL: Always differentiate between operations on specific documents vs operations on the entire system:

- REMOVE operations (e.g., remove_tag in bulk_edit_documents): Affect only the specified documents, items remain in the system
- DELETE operations (e.g., delete_tag, delete_correspondent): Permanently delete items from the entire system, affecting ALL documents that use them

When a user asks to "remove" something, prefer operations that affect specific documents. Only use DELETE operations when explicitly asked to delete from the system.

To view documents in your Paperless-NGX web interface, construct URLs using this pattern:
${resolvedPublicUrl}/documents/{document_id}/

Example: If your base URL is "http://localhost:8000", the web interface URL would be "http://localhost:8000/documents/123/" for document ID 123.

The document tools return JSON data with document IDs that you can use to construct these URLs.
      `,
    }
  );
  registerDocumentTools(server, api);
  registerTagTools(server, api);
  registerCorrespondentTools(server, api);
  registerDocumentTypeTools(server, api);
  registerCustomFieldTools(server, api);

  if (useHttp) {
    console.info("Using the HTTP mode");
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    let needsOauth = mcpClientId && mcpClientSecret;
    let auth: RequestHandler = (req, res, next) => {return next();};

    if (needsOauth) {
      console.log("Setting up OAuth")
      const proxyProvider = new ProxyOAuthServerProvider({
        endpoints: {
          authorizationUrl: mcpOauthUrl,
          tokenUrl: mcpTokenUrl,
          registrationUrl: "https://rauthy.ealex.net/auth/v1/clients_dyn",
        },
        verifyAccessToken: async token => {
          console.log("Token:", token)
          return {
            token,
            clientId: '123',
            scopes: ['openid', 'email']
          };
        },
        getClient: async client_id => {
          console.log("Client", client_id);
          return {
            client_id,
            redirect_uris: [`${mcpPublicHost}/oauth/callback`]
          };
        }
      });

      app.use(
        mcpAuthRouter({
          provider: proxyProvider,
          issuerUrl: new URL('https://rauthy.ealex.net'),
          baseUrl: new URL('https://rauthy.ealex.net'),
        })
      );


      const allowedUsers = mcpAllowedUsers.split(",").map(user => user.trim());

      auth = requireBearerAuth({provider: proxyProvider,});

      // if (allowedUsers.length > 0 && (!allowedUsers.includes(decoded["email"]) || !decoded["email_verified"])) {
      //   return cb("User not allowed", false);
      // }
    }

    // Store transports for each session
    const sseTransports: Record<string, SSEServerTransport> = {};

    app.post("/mcp", auth, async (req, res) => {
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

    app.get("/mcp", auth, async (req, res) => {
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

    app.delete("/mcp", auth, async (req, res) => {
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

    app.get("/sse", auth, async (req, res) => {
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

    app.post("/messages", auth, async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = sseTransports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res, req.body);
      } else {
        res.status(400).send("No transport found for sessionId");
      }
    });

    app.listen(resolvedPort, () => {
      console.log(
        `MCP Stateless Streamable HTTP Server listening on port ${resolvedPort}`
      );
    });
    // await new Promise((resolve) => setTimeout(resolve, 1000000));
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((e) => console.error(e.message));
