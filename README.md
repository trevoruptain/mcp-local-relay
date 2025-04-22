# MCP Kit Local Relay

## Purpose

This command-line tool acts as a bridge, allowing MCP clients (like Claude Desktop or Inspector) using `stdio` transport to interact with a _specific_ centrally hosted MCP server managed by the `mcp-kit-server` project.

**It acts as a proxy for a SINGLE target server defined in `mcpconfig.json`.**

## How it Works

1.  **Configuration Reading**: Reads `mcpconfig.json` for `targetServerId`.
2.  **Initialization**: If `targetServerId` is found:
    - Reads `MCPKIT_API_KEY` from `.env`.
    - Fetches server definition (name, tools) for the target server from `/mcp/servers?serverId=<targetId>`.
    - Fetches _file_ resource list for the target server from `/mcp/resources/list?serverId=<targetId>`.
3.  **Local Server**: Starts a local `McpServer` named after the target server.
4.  **Tool Registration**: Registers tools for the target server locally via `serverInstance.tool()`.
5.  **Resource Registration**: Registers _file_ resources for the target server locally via `serverInstance.resource()`. The read handler proxies to the backend.
6.  **Request Proxying**:
    - `tools/list`, `resources/list`: Handled locally by the SDK based on registered items.
    - `tools/call`: Proxied to the backend `/api/mcp/servers/:id/tools/:slug/execute`.
    - `resources/read`: Proxied to the backend `/mcp/resources/read?uri=...`.

## Technology Stack

- Node.js, TypeScript
- `@modelcontextprotocol/sdk`
- Axios, `dotenv`

## Setup and Running

1.  Install: `npm install`
2.  `.env`: Requires `MCPKIT_API_KEY`, `MCP_SERVER_URL`.
3.  `mcpconfig.json`: Requires `targetServerId` pointing to a valid server ID from the backend.
4.  Build: `npm run build`
5.  Run: `npm start`

6.  **Stack Size**: If `Maximum call stack size exceeded` occurs (large image resources), run with increased stack: `node --stack-size=32768 dist/index.js` (The `npm start` script includes this).

## Connections

- **Listens for**: Local MCP clients via `stdio`.
- **Connects to**: `server` project endpoints (`/mcp/servers`, `/mcp/resources/list`, `/mcp/resources/read`, `/api/mcp/servers/:id/tools/:slug/execute`).
