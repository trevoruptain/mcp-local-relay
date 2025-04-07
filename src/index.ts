import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import dotenv from "dotenv";
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

// OLD URL:
// const CENTRAL_SERVER_DISCOVERY_URL = `${CENTRAL_SERVER_BASE_URL}/api/mcp/relay/servers`;
// CORRECTED URL:
const CENTRAL_SERVER_DISCOVERY_URL = `${CENTRAL_SERVER_BASE_URL}/api/mcp/servers`;

// --- Updated Types for definitions received from server ---
// Matches the structure returned by /api/mcp/relay/servers
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
interface RelayTextContentItem {
  type: "text";
  text: string;
}

// --- Helper function to forward tool calls ---
// Update signature: parameters first, add context for the tool name
async function forwardToolCall(
  parameters: Record<string, any>, // Parameters come FIRST from SDK
  toolNameContext: string // Pass the tool name via closure
): Promise<{ content: RelayTextContentItem[]; isError: boolean }> {
  // 1. Parse the tool name passed via context
  const parts = toolNameContext.split("_"); // Use toolNameContext
  if (parts.length < 2) {
    const errorContentItem: RelayTextContentItem = {
      type: "text",
      text: "Internal relay error: Invalid tool name format.",
    };
    return { content: [errorContentItem], isError: true };
  }
  const serverId = parts[0];
  const toolName = parts.slice(1).join("_");

  // 2. Construct the dynamic execution URL (using serverId, toolName)
  const executeUrl = `${CENTRAL_SERVER_BASE_URL}/api/mcp/servers/${serverId}/tools/${toolName}/execute`;

  console.error(
    `Relay: Forwarding ${toolNameContext} to ${executeUrl}` // Log context name
  );
  console.error(`Relay: Forwarding parameters:`, parameters); // Log received parameters

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
      `Relay: Received response from central server for ${toolNameContext}: Status=${response.status}, Data=`,
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
      `Relay: Error forwarding ${toolNameContext} to ${executeUrl}:`, // Use context name in log
      error.message
    );
    let errorMessage = `Error executing tool '${toolNameContext}'.`; // Use context name
    let detailText = "Relay failed to communicate with the execution server.";

    if (axios.isAxiosError(error)) {
      if (error.response) {
        // Extract error details from the server's response if available
        errorMessage = `Error executing tool '${toolNameContext}' (Status: ${error.response.status}).`;
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
  // Use a generic name for the relay server itself
  const relayServerName = "MCP Kit Relay";

  try {
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

    // 2. Create McpServer instance
    serverInstance = new McpServer({
      name: relayServerName, // Use the generic relay name
      version: "1.0.0",
    });

    // Add null check after creation
    if (!serverInstance) {
      throw new Error("Failed to create McpServer instance.");
    }

    // 3. Dynamically register tools from ALL fetched servers
    for (const serverDef of serverDefinitions) {
      const serverAlias = serverDef.id; // Use server ID as a unique alias
      console.error(
        `Relay: Processing server "${serverDef.name}" (Alias: ${serverAlias})`
      );
      for (const toolDef of serverDef.tools) {
        // Sanitize server ID and tool name to fit MCP SDK requirements
        // Replace invalid chars with _, ensure length <= 64
        const sanitize = (name: string): string =>
          name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);

        const sanitizedServerId = sanitize(serverAlias);
        const sanitizedToolName = sanitize(toolDef.name);

        // Ensure names aren't empty after sanitization (edge case)
        if (!sanitizedServerId || !sanitizedToolName) {
          console.warn(
            `Skipping tool registration due to empty sanitized name for server ${serverAlias}, tool ${toolDef.name}`
          );
          continue;
        }

        // Construct the final name, ensuring it also fits the length limit
        const finalRegisteredName =
          `${sanitizedServerId}_${sanitizedToolName}`.substring(0, 64);

        // Map RelayToolParameter to Zod Schema for MCP SDK
        const parameters: { [key: string]: ZodTypeAny } = {}; // Expect Zod types as values
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
                zodSchema = z.any(); // Fallback for unknown types
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

        console.error(
          ` --> Registering: ${finalRegisteredName} (Original: ${serverAlias}_${toolDef.name})`
        );

        // Use a closure to capture finalRegisteredName
        const handler = async (params: Record<string, any>) => {
          // Call the actual forwarding function, passing the name and params
          return forwardToolCall(params, finalRegisteredName);
        };

        serverInstance.tool(
          finalRegisteredName,
          toolDef.description || "No description provided.",
          parameters,
          handler as any // Register the closure handler (keep 'as any' for safety)
        );
      }
    }

    console.error("Tool registration complete.");

    // 4. Connect using Stdio transport
    if (!serverInstance) {
      throw new Error("Server instance was not created.");
    }
    const transport = new StdioServerTransport();
    await serverInstance.connect(transport);
    console.error(
      `MCP Local Relay ("${relayServerName}") running on stdio, connected to ${CENTRAL_SERVER_BASE_URL}`
    );
  } catch (error: any) {
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
