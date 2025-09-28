#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { access, readFile, writeFile } from "fs/promises";
import { createServer } from "http";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const execAsync = promisify(exec);

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Hardcoded safe permissions - agents cannot modify these
// Allow network access for fetch/HTTP but no filesystem access
const HARDCODED_PERMISSIONS = ["net"];

// Configuration interface
interface CodemodeConfig {
  proxyPort?: number;
  configDirectories?: string[];
}

// Load configuration from codemode-config.json
async function loadCodemodeConfig(): Promise<CodemodeConfig> {
  try {
    const configPath = join(__dirname, "codemode-config.json");
    const configContent = await readFile(configPath, "utf-8");
    return JSON.parse(configContent);
  } catch (error) {
    console.error(
      "Warning: Could not load codemode-config.json, using defaults"
    );
    return {
      proxyPort: 3001,
      configDirectories: ["./"],
    };
  }
}

// Expand tilde in paths
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

// Check if Deno is installed
async function checkDenoInstalled(): Promise<boolean> {
  try {
    await execAsync("deno --version");
    return true;
  } catch (error) {
    return false;
  }
}

class CodemodeMcpServer {
  private server: Server;
  private denoInstalled: boolean = false;
  private mcpClients: Map<string, Client> = new Map();
  private config: CodemodeConfig = {
    proxyPort: 3001,
    configDirectories: ["./"],
  };

  constructor() {
    this.server = new Server(
      {
        name: "codemode-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.checkDenoStatus();

      return {
        tools: [
          {
            name: "execute_code",
            description:
              "Execute TypeScript/JavaScript code with access to other MCP servers via HTTP proxy. Write code that makes fetch() requests to interact with available MCP servers. Excellent for chaining multiple operations, processing data, and building complex workflows.\n\nMCP Proxy endpoints:\n- GET http://localhost:3001/mcp/servers - List available servers\n- GET http://localhost:3001/mcp/{server}/tools - List tools for server\n- POST http://localhost:3001/mcp/call - Call tool (body: {server, tool, args})\n\nUse when you need to: combine multiple MCP operations, process/transform data between calls, implement loops or conditional logic, or build multi-step workflows. Network access only, 30-second timeout.",
            inputSchema: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description:
                    "Complete TypeScript/JavaScript code to execute. Use fetch() to call MCP proxy endpoints. Use console.log() for output. Can import from https:// URLs.",
                },
                typescript: {
                  type: "boolean",
                  description:
                    "Whether code is TypeScript (true) or JavaScript (false). TypeScript recommended for type safety.",
                  default: true,
                },
              },
              required: ["code"],
              additionalProperties: false,
            },
          },
          {
            name: "check_deno_version",
            description:
              "Check Deno installation and version info. Use for troubleshooting code execution issues or verifying runtime capabilities.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: "list_servers_with_tools",
            description:
              "Get a comprehensive overview of all available MCP servers and their tools. Returns a structured list showing each server and all its available tools with descriptions.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await this.checkDenoStatus();

      if (!this.denoInstalled) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Deno runtime is not installed or not accessible.\n\nTo resolve this issue:\n1. Install Deno from https://deno.land/manual/getting_started/installation\n2. Ensure Deno is in your system PATH\n3. Try running 'deno --version' in your terminal to verify installation\n4. Restart this MCP server after installation\n\nQuick install commands:\n- macOS/Linux: curl -fsSL https://deno.land/x/install/install.sh | sh\n- Windows: irm https://deno.land/install.ps1 | iex",
            },
          ],
          isError: true,
        };
      }

      switch (request.params.name) {
        case "execute_code":
          return this.executeDenoCode(request.params.arguments);
        case "check_deno_version":
          return this.checkDenoVersion();
        case "list_servers_with_tools":
          return this.listServersWithTools();
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
          );
      }
    });
  }

  private async checkDenoStatus() {
    this.denoInstalled = await checkDenoInstalled();
  }

  private async executeDenoCode(args: any) {
    try {
      const { code, unstable = false, typescript = true } = args;

      if (!code) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No code provided for execution.\n\nPlease provide valid TypeScript or JavaScript code in the 'code' parameter.\n\nExample usage:\n{\n  \"code\": \"console.log('Hello, World!');\"\n}",
            },
          ],
          isError: true,
        };
      }

      if (typeof code !== "string") {
        return {
          content: [
            {
              type: "text",
              text: "Error: Invalid code parameter type.\n\nThe 'code' parameter must be a string containing TypeScript or JavaScript code.",
            },
          ],
          isError: true,
        };
      }

      // Create a temporary file with the code
      const tempDir = tmpdir();
      const fileExtension = typescript ? ".ts" : ".js";
      const filename = `deno-${uuidv4()}${fileExtension}`;
      const filepath = join(tempDir, filename);

      await writeFile(filepath, code);

      // Build the Deno command with hardcoded permissions
      const permFlags = HARDCODED_PERMISSIONS.map(
        (p: string) => `--allow-${p}`
      ).join(" ");
      const unstableFlag = unstable ? "--unstable" : "";
      const command = `deno run ${permFlags} ${unstableFlag} ${filepath}`;

      // Execute the code
      try {
        const { stdout, stderr } = await execAsync(command, { timeout: 30000 });

        return {
          content: [
            {
              type: "text",
              text: stdout
                ? `Output:\n${stdout}`
                : "Code executed successfully with no output.",
            },
            ...(stderr
              ? [{ type: "text", text: `Errors/Warnings:\n${stderr}` }]
              : []),
          ],
        };
      } catch (error: any) {
        let errorMessage = "Code execution failed.\n\n";

        if (error.stderr) {
          errorMessage += `Error Details:\n${error.stderr}\n\n`;
        }

        if (error.code === "ETIMEDOUT") {
          errorMessage +=
            "The code execution timed out after 30 seconds. Consider:\n";
          errorMessage += "- Reducing computation complexity\n";
          errorMessage += "- Breaking large operations into smaller chunks\n";
          errorMessage += "- Avoiding infinite loops or blocking operations\n";
        } else if (error.stderr && error.stderr.includes("permission")) {
          errorMessage +=
            "Permission denied. This MCP server only allows network access (--allow-net).\n";
          errorMessage += "The following operations are NOT permitted:\n";
          errorMessage += "- File system access (reading/writing files)\n";
          errorMessage += "- Environment variable access\n";
          errorMessage += "- System command execution\n";
          errorMessage += "- Plugin loading\n";
        } else if (error.stderr && error.stderr.includes("Module not found")) {
          errorMessage += "Module import failed. Remember:\n";
          errorMessage += "- Use https:// URLs for remote imports\n";
          errorMessage += "- Deno uses ES modules, not CommonJS\n";
          errorMessage += "- Check module URL spelling and availability\n";
        } else {
          errorMessage += `Error: ${
            error.message || "Unknown execution error"
          }\n\n`;
          errorMessage += "Common solutions:\n";
          errorMessage += "- Check syntax for TypeScript/JavaScript errors\n";
          errorMessage += "- Verify all imports use valid URLs\n";
          errorMessage += "- Ensure code is complete and self-contained\n";
        }

        return {
          content: [
            {
              type: "text",
              text: errorMessage,
            },
          ],
          isError: true,
        };
      }
    } catch (error: any) {
      let systemErrorMessage =
        "System error occurred during code execution setup.\n\n";
      systemErrorMessage += `Error: ${error.message}\n\n`;
      systemErrorMessage += "This typically indicates:\n";
      systemErrorMessage += "- Insufficient disk space for temporary files\n";
      systemErrorMessage += "- Permission issues with temporary directory\n";
      systemErrorMessage += "- System resource limitations\n";
      systemErrorMessage += "- Invalid file system state\n\n";
      systemErrorMessage += "Please check system resources and try again.";

      return {
        content: [
          {
            type: "text",
            text: systemErrorMessage,
          },
        ],
        isError: true,
      };
    }
  }

  private async checkDenoVersion() {
    try {
      const { stdout } = await execAsync("deno --version");
      return {
        content: [
          {
            type: "text",
            text: `Deno Version Information:\n${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Error checking Deno version: ${error.message}\n\nThis suggests Deno is not properly installed or accessible. Please:\n1. Install Deno from https://deno.land/\n2. Ensure Deno is in your system PATH\n3. Restart your terminal and this MCP server\n4. Try running 'deno --version' manually to verify installation`,
          },
        ],
        isError: true,
      };
    }
  }

  private async listServersWithTools() {
    const code = `
// Fetch all available MCP servers and their tools
const proxyPort = ${this.config.proxyPort};

try {
  // Get list of servers
  const serversResponse = await fetch(\`http://localhost:\${proxyPort}/mcp/servers\`);
  if (!serversResponse.ok) {
    throw new Error(\`Failed to fetch servers: \${serversResponse.statusText}\`);
  }

  const servers = await serversResponse.json();

  if (servers.length === 0) {
    console.log(JSON.stringify({
      summary: { totalServers: 0, successfulServers: 0, totalTools: 0 },
      servers: [],
      message: "No MCP servers configured"
    }, null, 2));
    Deno.exit(0);
  }

  const serversWithTools = [];

  for (const serverName of servers) {
    try {
      const toolsResponse = await fetch(\`http://localhost:\${proxyPort}/mcp/\${serverName}/tools\`);
      if (!toolsResponse.ok) {
        serversWithTools.push({
          server: serverName,
          status: 'error',
          error: \`Failed to fetch tools: \${toolsResponse.statusText}\`,
          tools: []
        });
        continue;
      }

      const toolsResult = await toolsResponse.json();
      const tools = toolsResult.tools || [];

      serversWithTools.push({
        server: serverName,
        status: 'success',
        toolCount: tools.length,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });

    } catch (error) {
      serversWithTools.push({
        server: serverName,
        status: 'error',
        error: error.message,
        tools: []
      });
    }
  }

  const successfulServers = serversWithTools.filter(s => s.status === 'success').length;
  const totalTools = serversWithTools.reduce((sum, s) => sum + (s.toolCount || 0), 0);

  // Output only structured JSON data
  console.log(JSON.stringify({
    summary: {
      totalServers: servers.length,
      successfulServers: successfulServers,
      totalTools: totalTools
    },
    servers: serversWithTools
  }, null, 2));

} catch (error) {
  console.log(JSON.stringify({
    error: \`Failed to fetch MCP server information: \${error.message}\`,
    summary: { totalServers: 0, successfulServers: 0, totalTools: 0 },
    servers: []
  }, null, 2));
  Deno.exit(1);
}
`;

    return this.executeDenoCode({ code, typescript: true });
  }

  private startHttpProxy() {
    const httpServer = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      try {
        if (req.url === "/mcp/servers") {
          const servers = await this.getMcpServers();
          res.end(JSON.stringify(servers));
        } else if (req.url?.startsWith("/mcp/") && req.url.includes("/tools")) {
          const serverName = req.url.split("/")[2];
          if (!serverName) throw new Error("Server name required");
          const tools = await this.listToolsForServer(serverName);
          res.end(JSON.stringify(tools));
        } else if (req.url === "/mcp/call" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            const { server, tool, args } = JSON.parse(body);
            const result = await this.callToolOnServer(server, tool, args);
            res.end(JSON.stringify(result));
          });
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found" }));
        }
      } catch (error: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    httpServer.listen(this.config.proxyPort, () => {
      console.error(
        `MCP proxy running on http://localhost:${this.config.proxyPort}`
      );
    });
  }

  private async getMcpServers() {
    const allServers = new Set<string>();

    for (const configDir of this.config.configDirectories || []) {
      const expandedDir = expandPath(configDir);
      const mcpConfigPath = join(expandedDir, ".mcp.json");

      try {
        await access(mcpConfigPath);
        const config = JSON.parse(await readFile(mcpConfigPath, "utf-8"));
        const serverNames = Object.keys(config.mcpServers || {}).filter(
          (name) => name !== "codemode"
        );

        for (const serverName of serverNames) {
          allServers.add(serverName);
        }
      } catch {
        // Silently skip directories without .mcp.json
      }
    }

    return Array.from(allServers);
  }

  private async listToolsForServer(serverName: string) {
    const client = await this.getOrCreateMcpClient(serverName);
    return await client.listTools();
  }

  private async callToolOnServer(
    serverName: string,
    toolName: string,
    args: any
  ) {
    const client = await this.getOrCreateMcpClient(serverName);
    return await client.callTool({ name: toolName, arguments: args });
  }

  private async getOrCreateMcpClient(serverName: string) {
    if (!this.mcpClients.has(serverName)) {
      const serverConfig = await this.findServerConfig(serverName);

      if (!serverConfig) {
        throw new Error(
          `Server '${serverName}' not found in any config directory`
        );
      }

      // Create MCP client with stdio transport (handles process spawning internally)
      const transport = new StdioClientTransport({
        command: serverConfig.command,
        args: serverConfig.args,
      });

      const client = new Client(
        {
          name: "deno-mcp-proxy",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      // Connect the client
      await client.connect(transport);

      this.mcpClients.set(serverName, client);
    }

    return this.mcpClients.get(serverName)!;
  }

  private async findServerConfig(serverName: string) {
    for (const configDir of this.config.configDirectories || []) {
      const expandedDir = expandPath(configDir);
      const mcpConfigPath = join(expandedDir, ".mcp.json");

      try {
        await access(mcpConfigPath);
        const config = JSON.parse(await readFile(mcpConfigPath, "utf-8"));

        if (config.mcpServers && config.mcpServers[serverName]) {
          return config.mcpServers[serverName];
        }
      } catch {
        // Silently skip directories without .mcp.json or invalid JSON
      }
    }

    return null;
  }

  async run() {
    // Load configuration
    this.config = await loadCodemodeConfig();
    console.error(
      `Loading config: proxy port ${
        this.config.proxyPort
      }, config dirs: ${this.config.configDirectories?.join(", ")}`
    );

    this.startHttpProxy();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Code Mode MCP server running on stdio");
  }
}

const server = new CodemodeMcpServer();
server.run().catch(console.error);
