# MCP Kit Local Relay

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

This command-line tool acts as a bridge, allowing local MCP clients that use standard input/output (`stdio`), like **Claude Desktop**, to interact with remote MCP Servers you've configured using the [MCP Kit Web App](https://app.mcpkit.ai).

It proxies requests to **one** target server at a time, making its tools and resources available locally.

## Getting Started (Claude Desktop Example)

Follow these steps to connect Claude Desktop to your remote MCP Server using this relay:

**Prerequisites:**

- Node.js (v18 or later recommended)
- npm (usually included with Node.js)
- Git

**Steps:**

1.  **Clone the Relay:**
    If you haven't already, clone this repository and navigate into the directory:

    ```bash
    git clone <repository_url> # Replace with the actual repo URL if needed
    cd local-relay
    ```

2.  **Install Dependencies:**

    ```bash
    npm install
    ```

3.  **Configure the Relay:**
    Create two configuration files directly inside the `local-relay` folder:

    - **`.env` file:** Create this file and add your MCP Kit API Key and the URL of your central MCP server. You can generate an API key [here](https://app.mcpkit.ai/api-keys).

      ```dotenv
      # Get your API Key from the MCP Kit Web App (app.mcpkit.ai) -> API Keys
      MCPKIT_API_KEY=your_api_key_here

      # URL of your running MCP Kit server project (defaults to localhost:3002 if omitted)
      # MCP_SERVER_URL=http://localhost:3002
      ```

      _(Replace `your_api_key_here` with your actual key)_

    - **`mcpconfig.json` file:** Create this file and specify the unique ID of the _single_ remote MCP Server you want this relay to connect to.
      ```json
      {
        "targetServerId": "your_target_server_id_here"
      }
      ```
      _(Replace `your_target_server_id_here` with the Server ID found on the MCP Kit Web App -> Servers page)_

4.  **Build the Relay:**
    Compile the code:

    ```bash
    npm run build
    ```

    This creates a `dist` directory with the necessary JavaScript files. The main script is `dist/index.js`.

5.  **Configure Claude Desktop:**
    You need to tell Claude Desktop how to run the relay script.

    - Open Claude Desktop settings (Menu -> Settings... -> Developer -> Edit Config).
    - Edit the `claude_desktop_config.json` file.
    - Add an entry under `mcpServers`. Use `node` as the `command` and provide the **full, absolute path** to the `dist/index.js` file you just built in the `args`.

    ```json
    {
      "mcpServers": {
        "my_mcp_server": {
          // Choose a name for Claude Desktop to display
          "command": "node",
          "args": [
            // Replace this with the *absolute* path!
            "/Users/yourname/path/to/local-relay/dist/index.js"
          ]
        }
      }
    }
    ```

    - **Important:** Replace the example path with the actual absolute path on your system.
    - For detailed instructions on editing the Claude config, see the [Local Relay Documentation](https://docs.mcpkit.ai/essentials/local-relay). _(Note: Update this link if the final URL is different)_

6.  **Restart Claude Desktop:**
    Quit and restart the Claude Desktop application completely.

7.  **Verify:**
    Click the hammer icon ![MCP Hammer Icon](https://mintlify.s3.us-west-1.amazonaws.com/mcp/images/claude-desktop-mcp-hammer-icon.svg) in Claude Desktop's chat input. You should see the tools from your target server listed under the name you chose (e.g., `my_mcp_server`).

You can now use your remote MCP server's tools directly within Claude Desktop!

## Running the Relay Manually

You can also run the relay directly from your terminal (e.g., for testing or use with other `stdio` clients):

```bash
npm start
```

This command executes `node --stack-size=32768 dist/index.js`. The relay will start listening for MCP commands on standard input. The `--stack-size` flag is included to prevent potential "Maximum call stack size exceeded" errors when dealing with large resources (like images).

## Troubleshooting

- **Claude Desktop Issues:**
  - Hammer icon missing or tools not listed?
  - Double-check the **absolute path** to `dist/index.js` in `claude_desktop_config.json`.
  - Verify `npm run build` completed without errors.
  - Ensure `.env` and `mcpconfig.json` exist in the `local-relay` directory and contain the correct API key and Server ID.
  - Check Claude Desktop's own logs (see [official MCP docs](https://modelcontextprotocol.io/quickstart/user) for locations).
- **Relay Errors:**
  - Check the `local-relay-debug.log` file created in the `local-relay` directory for detailed error messages from the relay itself.
  - Ensure your `MCP_SERVER_URL` in `.env` (or the default `http://localhost:3002`) points to a running instance of the `mcp-kit-server`.
  - Confirm your `MCPKIT_API_KEY` is valid.

## Development

To run the relay in development mode with automatic restarts on code changes:

```bash
npm run dev
```

This uses `nodemon` and `ts-node`.

## Contributing

Contributions are welcome! Please see `CONTRIBUTING.md` for guidelines.

## License

This project is licensed under the MIT License - see the `LICENSE` file for details.
