# MCP Kit Local Relay

## Purpose

This command-line tool (`mcp-kit-local-relay`) acts as a bridge, allowing MCP (Model Context Protocol) clients that only support local connections (via `stdio`) to interact with the centrally hosted MCP servers managed by the `mcp-kit-server` project.

It runs a local MCP server that discovers available tools from the central server and relays execution requests to it.

## How it Works

1.  **Initialization**: On startup, the relay reads the `MCPKIT_API_KEY` from `.env` and fetches all server and tool definitions from the central server's `/api/mcp/servers` endpoint.
2.  **Configuration Check**: It checks for the presence and validity of `mcpconfig.json` in its root directory.
    - **Single-Server Mode**: If `mcpconfig.json` contains a valid `targetServerId`, the relay filters the fetched definitions to use only the specified server. It adopts the target server's name for the local MCP server instance.
    - **Multi-Server Mode (Default)**: If `mcpconfig.json` is missing, invalid, or the `targetServerId` is not found, the relay proceeds with the definitions for all accessible servers and uses the generic name "MCP Kit Relay".
3.  **Local Server**: It starts a local MCP server using the `@modelcontextprotocol/sdk` and `StdioServerTransport`.
4.  **Dynamic Tool Registration**: It dynamically registers the selected tools (either from a single server or all servers) on the local server.
    - **Single-Server Mode**: Tool names are registered using their sanitized original names (e.g., `GetWeather`, `Vapi__Create_Assistant`), ensuring they conform to the MCP specification (`^[a-zA-Z0-9_-]{1,64}$`).
    - **Multi-Server Mode (Default)**: Tool names are namespaced using the sanitized format `{serverId}_{toolName}` to avoid collisions and conform to the spec.
5.  **Execution Forwarding**: When an MCP client connected to the local relay requests a tool execution:
    - The relay determines the correct central server ID and tool slug to use (either directly if in single-server mode, or by parsing the prefix if in multi-server mode).
    - It makes an authenticated POST request to the central server's execution endpoint (`/api/mcp/servers/{serverId}/tools/{toolSlug}/execute`), forwarding the parameters.
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

    - Create a `.env` file in the `local-relay` root directory (copy from `.env.example` if needed).
    - Add the following variables:
      ```dotenv
      MCPKIT_API_KEY=your_secret_api_key
      MCP_SERVER_URL=http://localhost:3002 # Or the URL of your deployed mcp-kit-server
      ```
    - Replace `your_secret_api_key` with the API key recognized by the `mcp-kit-server`.
    - Ensure `MCP_SERVER_URL` points to the correct base URL of your `mcp-kit-server` instance.

3.  **(Optional) Configure Target Server**:

    - By default, the relay connects to the `MCP_SERVER_URL` and exposes **all** tools from **all** servers accessible with your `MCPKIT_API_KEY`. Tool names will be prefixed with their server ID (e.g., `server1_GetWeather`).
    - To make the relay represent **only one specific server** and use its original tool names:
      - Create a configuration file named `mcpconfig.json` in the `local-relay` root directory.
      - You can copy `mcpconfig.example.json` to get started.
      - Set the `targetServerId` property to the ID of the server you want the relay to represent:
        ```json
        {
          "targetServerId": "your_desired_server_id_here"
        }
        ```
      - Find server IDs via the `web-app` or by inspecting the `server` database.
      - If `mcpconfig.json` exists and contains a valid `targetServerId`, the relay will:
        - Attempt to fetch only that server's definition.
        - Name the local relay instance after that server.
        - Register only that server's tools using their sanitized original names (e.g., `GetWeather`, `Vapi__Create_Assistant`).
      - If the file is missing, invalid, or the ID is not found, it reverts to the default behavior (loading all servers with prefixed names).

4.  **Build the Relay**:

    ```bash
    npm run build # Or equivalent script (likely runs tsc)
    ```

5.  **Run the Relay**:
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

The relay will connect to the central server, apply the configuration from `mcpconfig.json` (if present), register tools, and then wait for an MCP client to connect via stdio.

## Connections

- **Listens for**: Connections from local MCP clients via `stdio`.
- **Connects to**: The `server` project's `/api/mcp/servers` (for discovery) and `/api/mcp/servers/.../execute` (for execution) endpoints, using `MCPKIT_API_KEY` for authentication.
