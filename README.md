# MCP Kit Local Relay

## Purpose

This command-line tool (`mcp-kit-local-relay`) acts as a bridge, allowing MCP (Model Context Protocol) clients that primarily use local connections (like `stdio`) to interact with the centrally hosted MCP servers managed by the `mcp-kit-server` project.

**It acts as a proxy for a SINGLE target server defined in `mcpconfig.json`.**

## How it Works

1.  **Configuration Reading**: Reads `mcpconfig.json` to determine the `targetServerId` it should proxy for.
2.  **Initialization**: On startup, if a `targetServerId` is found:
    - It reads the `MCPKIT_API_KEY` from `.env`.
    - It fetches the server definition (name, tools) for _only_ the `targetServerId` from the central server's `/mcp/relay/servers?serverId=<targetId>` endpoint.
    - It fetches the resource list for _only_ the `targetServerId` from the central server's `/mcp/resources/list?serverId=<targetId>` endpoint.
3.  **Local Server**: It starts a local MCP server using the `@modelcontextprotocol/sdk` (`McpServer`) and `StdioServerTransport`.
    - The local server instance is named after the target server.
    - It declares capabilities for `tools` and `resources` based on whether the target server has them.
4.  **Dynamic Tool Registration**: It registers only the tools belonging to the `targetServerId` locally using `serverInstance.tool()`.
5.  **Static Resource Registration**: It registers only the resources belonging to the `targetServerId` locally using `serverInstance.resource()`. The `read` handler for each registered resource proxies the request to the central server.
6.  **Request Proxying**:
    - `tools/list`: Handled locally by the SDK, returning the tools registered in step 4.
    - `resources/list`: Handled locally by the SDK, returning the resources registered in step 5.
    - `tools/call`: Proxied via `forwardToolCall` function to the central server's `/api/mcp/servers/:serverId/tools/:toolSlug/execute` endpoint.
    - `resources/read`: Proxied via the registered read handler to the central server's `/mcp/resources/read?uri=...` endpoint.

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
    ```
2.  **Environment Variables**:
    - Create a `.env` file in the `local-relay` root directory.
    - Add the following variables:
      ```dotenv
      MCPKIT_API_KEY=your_secret_api_key # Must match server
      MCP_SERVER_URL=http://localhost:3002 # URL of your mcp-kit-server
      ```
3.  **Configure Target Server**:
    - Create `mcpconfig.json` in the `local-relay` root.
    - Set the `targetServerId` property to the ID of the server you want the relay to represent:
      ```json
      {
        "targetServerId": "your_desired_server_id_here"
      }
      ```
    - **This is mandatory for the relay to function correctly.**
4.  **Build the Relay**:
    ```bash
    npm run build
    ```
5.  **Run the Relay**:

    ```bash
    npm start
    # OR directly:
    # node dist/index.js
    ```

6.  **IMPORTANT: Stack Size for Large Resources**:
    - If you encounter **"Maximum call stack size exceeded"** errors when reading large resources (especially images), you need to increase Node.js's stack size limit.
    - Run the `start` script with the flag:
      ```bash
      node --stack-size=32768 dist/index.js
      ```
    - Start with `16384` or `32768` and increase if needed. This must be done when launching the process.
    - The default `npm start` script in `package.json` already includes `--stack-size=32768`.

## Connections

- **Listens for**: Connections from local MCP clients via `stdio`.
- **Connects to**: The `server` project's `/mcp/relay/servers` (for definitions), `/mcp/resources/list` (for resources), `/mcp/resources/read` (for reading), and `/api/mcp/servers/:id/tools/:slug/execute` (for tool execution) endpoints, using `MCPKIT_API_KEY` for authentication.
