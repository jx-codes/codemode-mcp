# Code Mode MCP Server

A local implementation of the "Code Mode" workflow for MCP servers. Instead of struggling with multiple tool calls, LLMs write TypeScript/JavaScript code that calls a simple HTTP proxy to access your MCP servers.

Note: It does not attempt to handle the MCP -> typescript API transpilation layer. Would be cool but I really wanted to test the workflow.

https://blog.cloudflare.com/code-mode/

## What is this?

This implements the core insight that **LLMs are much better at writing code than at tool calling**. Instead of exposing many tools directly to the LLM (which it struggles with), this server gives the LLM just one tool: `execute_code`. The LLM writes code that makes HTTP requests to access your other MCP servers.

## How it works

1. **LLM gets one tool**: `execute_code` - executes TypeScript/JavaScript
2. **LLM writes code**: Uses `fetch()` to call `http://localhost:3001/mcp/*` endpoints
3. **HTTP proxy forwards**: Transparently proxies requests to your actual MCP servers
4. **Results flow back**: Through the code execution to the LLM

This gives you all the benefits of complex tool orchestration, but leverages what LLMs are actually good at: writing code.
## Installation

### Prerequisites

- [Bun](https://bun.sh) (latest version)
- [Deno](https://deno.land) (for code execution sandbox)
- An MCP-compatible client (Claude Desktop, Cursor, VS Code with Copilot, etc.)

### Setup

1. **Clone the repository**
```bash
git clone https://github.com/jx-codes/codemode-mcp.git
cd codemode-mcp
```

2. **Install dependencies**
```bash
bun install
```
3. **Configure the server** (optional)

Create a `codemode-config.json` file to customize settings:
```json
{
   "proxyPort": 3001,
   "configDirectories": [
      "~/.config/mcp/servers",
      "./mcp-servers",
      "./"
   ]
}
```

4. **Set up your MCP servers**

Create a `.mcp.json` file with your MCP server configurations in any of the directories you specified above:
```json
{
   "mcpServers": {
      "fs": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
         "env": {}
      }
   }
}
```

## Example Workflows

### Single MCP Server Call

Instead of direct tool calling, the LLM writes:

```typescript
// List available servers
const servers = await fetch("http://localhost:3001/mcp/servers").then((r) =>
  r.json()
);
console.log("Available servers:", servers);

// Call a tool on the filesystem server
const result = await fetch("http://localhost:3001/mcp/call", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    server: "fs",
    tool: "read_file",
    args: { path: "/tmp/example.txt" },
  }),
}).then((r) => r.json());

console.log("File contents:", result);
```

### Chaining Multiple Operations

The real power shows when chaining operations:

```typescript
// Get list of files
const files = await fetch("http://localhost:3001/mcp/call", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    server: "fs",
    tool: "list_directory",
    args: { path: "/tmp" },
  }),
}).then((r) => r.json());

// Process each file
for (const file of files.content[0].text.split("\n")) {
  if (file.endsWith(".txt")) {
    const content = await fetch("http://localhost:3001/mcp/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        server: "fs",
        tool: "read_file",
        args: { path: `/tmp/${file}` },
      }),
    }).then((r) => r.json());

    console.log(`${file}: ${content.content[0].text.length} characters`);
  }
}
```

## Tools

### `execute_code`

Executes TypeScript/JavaScript code with network access to the MCP proxy.

**Parameters:**

- `code` (string): Code to execute
- `typescript` (boolean): TypeScript mode (default: true)

**Proxy Endpoints:**

- `GET /mcp/servers` - List available MCP servers
- `GET /mcp/{server}/tools` - List tools for server
- `POST /mcp/call` - Call tool (body: `{server, tool, args}`)

### `check_deno_version`

Check Deno installation status.

### `list_servers_with_tools`

Get a comprehensive overview of all available MCP servers and their tools. Returns structured JSON data optimized for LLM consumption, containing complete tool schemas and server status information.

**JSON Output Structure:**

```json
{
  "summary": {
    "totalServers": 2,
    "successfulServers": 2,
    "totalTools": 4
  },
  "servers": [
    {
      "server": "filesystem",
      "status": "success",
      "toolCount": 3,
      "tools": [
        {
          "name": "read_file",
          "description": "Read contents of a file",
          "inputSchema": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "File path to read"
              }
            },
            "required": ["path"]
          }
        }
      ]
    },
    {
      "server": "database",
      "status": "success",
      "toolCount": 1,
      "tools": [
        {
          "name": "query",
          "description": "Execute a SQL query",
          "inputSchema": {
            "type": "object",
            "properties": {
              "query": {
                "type": "string",
                "description": "SQL query to execute"
              }
            },
            "required": ["query"]
          }
        }
      ]
    }
  ]
}
```

This provides complete tool discovery information including parameter schemas, types, and requirements for programmatic access.

## Configuration

Create `codemode-config.json`:

```json
{
  "proxyPort": 3001,
  "configDirectories": ["~/.config/mcp/servers", "./mcp-servers", "./"]
}
```

Add your MCP servers to `.mcp.json` files in those directories:

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    }
  }
}
```

## Why (Might) Work Better

**Traditional MCP**: LLM → Tool Call → MCP Server → Result → LLM → Tool Call → ...

- LLMs struggle with tool syntax
- Each call goes through the neural network
- Hard to chain operations
- Limited by training on synthetic tool examples

**Code Mode**: LLM → Write Code → Code calls proxy → Proxy forwards to MCP → Results

- LLMs excel at writing code (millions of real examples in training)
- Code can chain operations naturally
- Results flow through code logic, not neural network
- Natural composition and data processing

## Security

- Code runs in Deno sandbox with **network access only**
- No filesystem, environment, or system access
- 30-second execution timeout
- MCP servers accessed through controlled proxy
- Temporary files auto-cleanup

## Troubleshooting

**"Deno not installed"**: Install Deno and restart
**"Permission denied"**: Code trying to access restricted resources
**"Module not found"**: Use `https://` URLs for imports
**"Execution timeout"**: Optimize code or break into smaller operations

## TODO (Maybe)

- Provide a simpler API layer for the MCP proxy something like mcp.tool('name', args);
  - Could easily be done by injecting our own typescript file into the Deno scope before running user code
- More config options
- Filter out the tools somehow
- Test it out more in my workflows and see the results

## Deno code remixed from: https://github.com/Timtech4u/deno-mcp-server
