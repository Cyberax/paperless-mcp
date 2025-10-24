#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import session from "express-session";
import { parseArgs } from "node:util";
import { PaperlessAPI } from "./api/PaperlessAPI";
import { registerCorrespondentTools } from "./tools/correspondents";
import { registerCustomFieldTools } from "./tools/customFields";
import { registerDocumentTools } from "./tools/documents";
import { registerDocumentTypeTools } from "./tools/documentTypes";
import { registerTagTools } from "./tools/tags";
import passport from "passport";
import OAuth2Strategy from "passport-oauth2";
import { jwtDecode } from "jwt-decode";

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
    let auth = (cb) => {return cb};

    if (needsOauth) {
      console.log("Setting up OAuth")
      let sess = {
        secret: mcpClientSecret + "sess", // Just reuse the secret
        cookie: {}
      }
      app.use(session(sess));

      app.use(passport.initialize());
      app.use(passport.session());

      passport.serializeUser((user, done) => {
        done(null, JSON.stringify(user));
      });

      passport.deserializeUser(async (saved: string, done) => {
        done(null, JSON.parse(saved));
      });

      const allowedUsers = mcpAllowedUsers.split(",").map(user => user.trim());

      let oauth2Strategy = new OAuth2Strategy({
          authorizationURL: mcpOauthUrl,
          tokenURL: mcpTokenUrl,
          clientID: mcpClientId,
          clientSecret: mcpClientSecret,
          callbackURL: `${mcpPublicHost}/oauth/callback`,
          scope: ["email"],
        },
        function(accessToken, refreshToken, results, profile, cb) {
          const decoded = jwtDecode(results['id_token']);
          if (allowedUsers.length > 0 && (!allowedUsers.includes(decoded["email"]) || !decoded["email_verified"])) {
            return cb("User not allowed", false);
          }
          return cb(null, {
            "id": decoded["sub"],
            "username": decoded["email"],
          });
        }
      );
      passport.use(oauth2Strategy);

      app.get('/oauth/callback',
        passport.authenticate('oauth2', { failureRedirect: '/' }),
        function(req, res) {
          // Successful authentication, redirect home.
          res.redirect('/');
        });

      auth = passport.authenticate('oauth2', { failureRedirect: '/' });
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
