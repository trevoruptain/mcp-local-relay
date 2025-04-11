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
      const serverId = serverDef.id; // Use actual server ID
      console.error(
        `Relay: Processing server "${serverDef.name}" (ID: ${serverId})` // Use ID in log
      );
      for (const toolDef of serverDef.tools) {
        // Sanitize server ID and tool name for the *registered* name
        const sanitize = (name: string): string =>
          name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);

        const sanitizedServerId = sanitize(serverId);
        const sanitizedToolName = sanitize(toolDef.name);
        const toolSlugToForward = toolDef.slug; // <-- Get the actual slug to use for forwarding

        // Ensure names aren't empty after sanitization (edge case)
        if (!sanitizedServerId || !sanitizedToolName) {
          console.warn(
            `Skipping tool registration due to empty sanitized name for server ${serverId}, tool ${toolDef.name}`
          );
          continue;
        }

        // Construct the final name that the MCP client will see
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

        // Define the handler, capturing necessary context (serverId and slug)
        const handler = async (params: Record<string, any>) => {
          // Pass parameters, serverId, and the *actual slug* to forwardToolCall
          return await forwardToolCall(params, serverId, toolSlugToForward);
        };

        console.error(
          `Relay: Registering tool "${finalRegisteredName}" (Slug: ${toolSlugToForward}) for server ${serverId}`
        );

        // Correctly use the .tool() method with positional arguments
        serverInstance.tool(
          finalRegisteredName, // Use the combined name for registration
          toolDef.description || "", // Pass description or empty string
          parameters, // Pass the Zod parameters schema
          handler // Pass the handler which captures slug and serverId
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
