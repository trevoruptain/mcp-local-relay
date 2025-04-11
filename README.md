# MCP Kit Local Relay

## Purpose

This command-line tool (`mcp-kit-local-relay`) acts as a bridge, allowing MCP (Model Context Protocol) clients that only support local connections (via `stdio`) to interact with the centrally hosted MCP servers managed by the `mcp-kit-server` project.

It runs a local MCP server that discovers available tools from the central server and relays execution requests to it.

## How it Works

1.  **Initialization**: On startup, the relay fetches all server and tool definitions from the central server's `/api/mcp/servers` endpoint using the provided API key.
2.  **Local Server**: It starts a local MCP server using the `@modelcontextprotocol/sdk` and `StdioServerTransport`.
3.  **Dynamic Tool Registration**: It dynamically registers all discovered tools on the local server. Tool names are namespaced using the format `{serverId}_{toolName}` to avoid collisions.
4.  **Execution Forwarding**: When an MCP client connected to the local relay requests a tool execution:
    - The relay identifies the target central server and tool name from the namespaced tool name.
    - It makes an authenticated POST request to the central server's execution endpoint (`/api/mcp/servers/{serverId}/tools/{toolName}/execute`), forwarding the parameters.
    - It returns the result received from the central server back to the local MCP client.

## Technology Stack

- Node.js
- TypeScript
- `@modelcontextprotocol/sdk`
- Axios
- `dotenv`

## Setup and Running

1.  **Install Dependencies**:
    ```bash
    npm install
    # or yarn install / pnpm install
    ```
2.  **Environment Variables**:
    - Create a `.env` file in the `local-relay` root directory.
    - Add the following variables:
      ```dotenv
      MCPKIT_API_KEY=your_secret_api_key
      MCP_SERVER_URL=http://localhost:3002 # Or the URL of your deployed mcp-kit-server
      ```
    - Replace `your_secret_api_key` with the API key recognized by the `mcp-kit-server`.
    - Ensure `MCP_SERVER_URL` points to the correct base URL of your `mcp-kit-server` instance.
3.  **Build the Relay**:
    ```bash
    npm run build # Or equivalent script (likely runs tsc)
    ```
4.  **Run the Relay**:
    - Using the globally linked bin (if set up via `npm link` or global install):
      ```bash
      mcp-kit-local-relay
      ```
    - Directly via node:
      ```bash
      node dist/index.js
      ```
    - Via npm/yarn/pnpm run scripts (if defined in `package.json`):
      ```bash
      npm start # Or similar script
      ```

The relay will connect to the central server, register tools, and then wait for an MCP client to connect via stdio.

## Connections

- **Listens for**: Connections from local MCP clients via `stdio`.
- **Connects to**: The `server` project's `/api/mcp/servers` (for discovery) and `/api/mcp/servers/.../execute` (for execution) endpoints, using `MCPKIT_API_KEY` for authentication.
