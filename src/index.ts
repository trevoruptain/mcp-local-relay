import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z, ZodTypeAny } from "zod";

// Load environment variables from the project root
const envPath = path.resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

// Read API key from environment
const apiKey = process.env.MCPKIT_API_KEY;
if (!apiKey) {
  console.error("FATAL ERROR: Environment variable MCPKIT_API_KEY is not set.");
  process.exit(1);
}

// Define the BASE URL for the central mcp-kit-server (ensure this is correct)
const CENTRAL_SERVER_BASE_URL =
  process.env.MCP_SERVER_URL || "http://localhost:3002";

// CORRECTED URL:
const CENTRAL_SERVER_DISCOVERY_URL = `${CENTRAL_SERVER_BASE_URL}/api/mcp/servers`;

// Configuration file path
const configPath = path.resolve(__dirname, "../mcpconfig.json");

// --- Types ---
interface RelayConfig {
  targetServerId?: string;
}

// Matches the structure returned by /api/mcp/servers
interface DbToolParameter {
  // Simplified, server handles full validation
  name: string;
  description: string | null;
  type: string; // e.g., "string", "number"
  required: boolean;
}

interface RelayToolDefinition {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parameters: DbToolParameter[];
  // We don't need steps/execution details in the relay
}

interface RelayServerDefinition {
  id: string;
  name: string;
  description: string | null;
  tools: RelayToolDefinition[];
}

// Define a local type for the content items the relay *actually* produces
// Add index signature to satisfy SDK's expected handler return type
interface RelayTextContentItem {
  [key: string]: any; // Index signature
  type: "text";
  text: string;
}

// --- Helper function to forward tool calls ---
// Update signature: parameters first, add serverId and toolSlug
async function forwardToolCall(
  parameters: Record<string, any>,
  serverId: string, // Pass serverId directly
  toolSlug: string // Pass toolSlug directly
  // Ensure the return type matches the complex type expected by the SDK handler
): Promise<{ content: RelayTextContentItem[]; isError?: boolean }> {
  // 1. Construct the dynamic execution URL (using serverId, toolSlug)
  const executeUrl = `${CENTRAL_SERVER_BASE_URL}/api/mcp/servers/${serverId}/tools/${toolSlug}/execute`;

  console.error(
    `Relay: Forwarding call for tool slug '${toolSlug}' on server ${serverId} to ${executeUrl}`
  );
  console.error(`Relay: Forwarding parameters:`, parameters);

  try {
    // 3. Make the POST request (pass received parameters)
    const response = await axios.post<{ result: string; isError: boolean }>(
      executeUrl,
      parameters, // Use received parameters
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    console.error(
      `Relay: Received response from central server for slug '${toolSlug}': Status=${response.status}, Data=`,
      response.data
    );

    // 4. Format the response (using response.data)
    if (response.data && typeof response.data.result === "string") {
      const contentItem: RelayTextContentItem = {
        type: "text",
        text: response.data.result,
      };
      return {
        content: [contentItem],
        isError: response.data.isError ?? false,
      };
    } else {
      console.error(
        "Relay: Invalid response format from central server execution endpoint:",
        response.data
      );
      const errorContentItem: RelayTextContentItem = {
        type: "text",
        text: "Error: Invalid response format from tool execution server.",
      };
      return {
        content: [errorContentItem],
        isError: true,
      };
    }
  } catch (error: any) {
    console.error(
      `Relay: Error forwarding call for slug '${toolSlug}' on server ${serverId} to ${executeUrl}:`,
      error.message
    );
    let errorMessage = `Error executing tool '${toolSlug}'.`; // Use slug in error
    let detailText = "Relay failed to communicate with the execution server.";

    if (axios.isAxiosError(error)) {
      if (error.response) {
        // Extract error details from the server's response if available
        errorMessage = `Error executing tool '${toolSlug}' (Status: ${error.response.status}).`; // Use slug
        detailText = `Server Error: ${
          error.response.data?.error ||
          error.response.data?.details ||
          JSON.stringify(error.response.data)
        }`;
      } else if (error.request) {
        detailText =
          "No response received from the execution server (timeout or network issue).";
      } else {
        detailText = `Axios error: ${error.message}`;
      }
    } else {
      // General error
      detailText = error.message;
    }

    // Return error in MCP SDK format using ContentItem
    const errorContentItem: RelayTextContentItem = {
      type: "text",
      text: `${errorMessage} ${detailText}`.substring(0, 1000),
    };
    return {
      content: [errorContentItem],
      isError: true,
    };
  }
}

// --- Main function to initialize and start the relay server ---
async function main() {
  let serverInstance: McpServer | null = null;
  // Use a generic name for the relay server itself initially
  const relayServerName = "MCP Kit Relay";
  let targetServerId: string | undefined = undefined;
  let targetServerName: string | undefined = undefined;

  try {
    // --- Read Configuration ---
    try {
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8");
        const config: RelayConfig = JSON.parse(configContent);
        targetServerId = config.targetServerId;
        if (targetServerId === "YOUR_SERVER_ID_HERE") {
          console.warn(
            `Relay: Found default placeholder in ${configPath}. Please replace "YOUR_SERVER_ID_HERE" with an actual Server ID.`
          );
          targetServerId = undefined;
        } else if (targetServerId) {
          console.error(
            `Relay: Loaded target server ID "${targetServerId}" from ${configPath}`
          );
        }
      } else {
        console.warn(
          `Relay: Configuration file not found at ${configPath}. Will load all servers.`
        );
      }
    } catch (error: any) {
      console.error(
        `Relay: Error reading or parsing ${configPath}: ${error.message}. Will load all servers.`
      );
      targetServerId = undefined;
    }
    // --- End Configuration Reading ---

    // 1. Fetch definitions from the NEW central server endpoint
    const definitionsUrl = `${CENTRAL_SERVER_DISCOVERY_URL}`;
    console.error(
      `Relay: Preparing to fetch definitions from ${definitionsUrl}...`
    );
    // Expect an array of RelayServerDefinition
    const definitionsResponse = await axios.get<RelayServerDefinition[]>(
      definitionsUrl,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json", // Specify we want JSON
        },
      }
    );
    console.error(
      `Relay: axios.get for definitions completed. Status: ${definitionsResponse.status}`
    );
    const serverDefinitions = definitionsResponse.data;

    console.error(
      `Relay: Received definitions for ${serverDefinitions.length} servers.`
    );

    // --- Filter servers if targetServerId is specified ---
    let serversToRegister: RelayServerDefinition[] = serverDefinitions;
    if (targetServerId) {
      const targetServer = serverDefinitions.find(
        (s) => s.id === targetServerId
      );
      if (targetServer) {
        serversToRegister = [targetServer];
        targetServerName = targetServer.name;
        console.error(
          `Relay: Found target server "${targetServerName}" (ID: ${targetServerId}). Registering its tools only.`
        );
      } else {
        console.warn(
          `Relay: Target server ID "${targetServerId}" not found in fetched definitions. Loading all servers instead.`
        );
        targetServerId = undefined;
      }
    }
    // --- End Filtering ---

    // 2. Create McpServer instance
    console.error(
      `Relay: Attempting to create McpServer instance with name: "${
        targetServerName || relayServerName
      }"`
    );
    serverInstance = new McpServer({
      name: targetServerName || relayServerName,
      version: "1.0.0",
    });

    // Add null check after creation
    if (!serverInstance) {
      throw new Error("Failed to create McpServer instance.");
    }

    // 3. Dynamically register tools from filtered servers
    for (const serverDef of serversToRegister) {
      const serverId = serverDef.id;
      console.error(
        `Relay: Processing server "${serverDef.name}" (ID: ${serverId})`
      );
      for (const toolDef of serverDef.tools) {
        const sanitize = (name: string): string =>
          name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);

        // Sanitize the tool name itself to conform to MCP spec ^[a-zA-Z0-9_-]{1,64}$
        const sanitizedToolName = sanitize(toolDef.name);

        // If a targetServerId is set, use ONLY the sanitized tool NAME.
        // Otherwise (multi-server mode), use the sanitized serverId + tool SLUG for guaranteed uniqueness.
        const finalRegisteredName = targetServerId
          ? sanitizedToolName // Single-server mode: Use sanitized original name
          : `${sanitize(serverId)}_${sanitize(toolDef.slug)}`.substring(0, 64); // Multi-server mode: Use sanitized serverId + sanitized slug

        const toolSlugToForward = toolDef.slug;

        // Ensure names aren't empty after sanitization (edge case)
        if (!finalRegisteredName) {
          console.warn(
            `Skipping tool registration due to empty sanitized name for server ${serverId}, tool ${toolDef.name}`
          );
          continue;
        }

        // Map RelayToolParameter to Zod Schema for MCP SDK
        const parameters: { [key: string]: ZodTypeAny } = {};
        if (toolDef.parameters && Array.isArray(toolDef.parameters)) {
          toolDef.parameters.forEach((param) => {
            let zodSchema: ZodTypeAny;

            // Determine base Zod type
            switch (param.type?.toLowerCase()) {
              case "string":
                zodSchema = z.string();
                break;
              case "number":
                zodSchema = z.number();
                break;
              case "boolean":
                zodSchema = z.boolean();
                break;
              // Add cases for other simple types if needed (e.g., integer)
              default:
                console.warn(
                  `Relay: Unknown parameter type "${param.type}" for ${param.name}. Using z.any().`
                );
                zodSchema = z.any();
            }

            // Add description
            if (param.description) {
              zodSchema = zodSchema.describe(param.description);
            }

            // Handle optional parameters
            if (!param.required) {
              zodSchema = zodSchema.optional();
            }

            parameters[param.name] = zodSchema;
          });
        }

        // Define the handler, capturing necessary context (serverId and slug)
        const handler = async (params: Record<string, any>) => {
          // Pass parameters, serverId, and the *actual slug* to forwardToolCall
          return await forwardToolCall(
            params,
            serverId, // Pass the original serverId
            toolSlugToForward // Pass the original slug
          );
        };

        // Register the tool using the correct .tool() method
        serverInstance.tool(
          finalRegisteredName, // Use the potentially original name
          toolDef.description || "", // Pass description or empty string
          parameters, // Pass the raw parameters object directly
          handler // Pass the handler which captures slug and serverId
        );

        console.error(
          `Relay: Registered tool '${finalRegisteredName}' (forwards to server ${serverId}, slug ${toolSlugToForward})`
        );
      }
    }

    // 4. Start the server using Stdio transport
    if (!serverInstance) {
      console.error("Relay: Failed to initialize McpServer instance.");
      // Remove the destroy call as serverInstance is null here
      return; // Exit if registration failed
    }

    console.error(
      "Relay: Initialization complete. Starting StdioServerTransport..."
    );
    // Correctly instantiate StdioServerTransport without arguments
    const transport = new StdioServerTransport();
    await serverInstance.connect(transport);
    console.error(
      `Relay: ${targetServerName || relayServerName} connected via Stdio.`
    );
  } catch (error: any) {
    // Catch errors during initialization
    console.error("Relay: Entered CATCH block in main(). Error:", error);
    let errorMessage = "Fatal error initializing MCP Local Relay:";
    if (axios.isAxiosError(error)) {
      errorMessage += ` Failed to connect or process definitions from ${CENTRAL_SERVER_BASE_URL}. Ensure the central server is running and API key is valid. Error: ${error.message}`;
      if (error.response) {
        errorMessage += ` Server responded with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`;
      }
    } else {
      errorMessage += ` ${error.message}`;
    }
    console.error(errorMessage, error);
    process.exit(1);
  }
}

main().catch((error) => {
  // Catch any unexpected errors during main execution (already handled in try/catch)
  console.error("Unexpected fatal error in Relay main():", error);
  process.exit(1);
});
