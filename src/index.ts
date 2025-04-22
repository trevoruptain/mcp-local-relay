import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Resource } from "@modelcontextprotocol/sdk/types";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z, ZodTypeAny } from "zod";

// Load environment variables from the project root
const envPath = path.resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

// --- IMPORTANT RUNTIME NOTE ---
// If you encounter "Maximum call stack size exceeded" errors, especially when
// reading large resources (like images), you may need to increase Node.js's
// default stack size limit. Run the relay using the --stack-size flag:
//
// Example using compiled output (npm run start):
//   node --stack-size=32768 dist/index.js
//
// Example using ts-node (npm run dev):
//   nodemon --watch src --exec "node --stack-size=32768 -r ts-node/register -r tsconfig-paths/register src/index.ts"
//
// Start with a value like 16384 or 32768 (KB) and increase if necessary.
// This flag must be passed when launching the Node process.
// -----------------------------

// Read API key from environment
const apiKey = process.env.MCPKIT_API_KEY;
if (!apiKey) {
  console.error("FATAL ERROR: Environment variable MCPKIT_API_KEY is not set.");
  process.exit(1);
}

// Define the BASE URL for the central mcp-kit-server (ensure this is correct)
const CENTRAL_SERVER_BASE_URL =
  process.env.MCP_SERVER_URL || "http://localhost:3002";

// Point to the correct relay-specific server definitions endpoint
const CENTRAL_SERVER_DISCOVERY_URL = `${CENTRAL_SERVER_BASE_URL}/api/mcp/relay/servers`;

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

// --- Helper function to forward tool calls ---
// Update signature: parameters first, add serverId and toolSlug
async function forwardToolCall(
  parameters: Record<string, any>,
  serverId: string, // Pass serverId directly
  toolSlug: string // Pass toolSlug directly
  // Ensure the return type matches the complex type expected by the SDK handler
): Promise<{ content: any[]; isError?: boolean }> {
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
      const contentItem: any = {
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
      const errorContentItem: any = {
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
    const errorContentItem: any = {
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
  const relayServerName = "MCP Kit Relay";
  let targetServerId: string | undefined = undefined;
  let targetServerName: string | undefined = undefined;
  let targetServerResources: Resource[] = []; // Store fetched resources
  let serverDefinition: RelayServerDefinition | null = null; // Store fetched server def

  try {
    // --- Read Configuration ---
    try {
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8");
        const config: RelayConfig = JSON.parse(configContent);
        targetServerId = config.targetServerId;
        if (targetServerId === "YOUR_SERVER_ID_HERE") {
          // console.warn(
          //   `Relay: Found default placeholder in ${configPath}. Please replace "YOUR_SERVER_ID_HERE" with an actual Server ID.`
          // );
          targetServerId = undefined;
        } else if (targetServerId) {
          // console.error(
          //   `Relay: Loaded target server ID "${targetServerId}" from ${configPath}`
          // );
        }
      } else {
        // console.warn(
        //   `Relay: Configuration file not found at ${configPath}. Will load all servers.`
        // );
      }
    } catch (error: any) {
      console.error(
        `Relay: Error reading or parsing ${configPath}: ${error.message}. Will load all servers.`
      );
      targetServerId = undefined;
    }
    // --- End Configuration Reading ---

    // --- Fetch Definition AND Resources for Target Server ---
    if (targetServerId) {
      const definitionsUrl = `${CENTRAL_SERVER_BASE_URL}/api/mcp/relay/servers?serverId=${targetServerId}`;
      try {
        const definitionsResponse = await axios.get<RelayServerDefinition[]>(
          definitionsUrl,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              Accept: "application/json",
            },
          }
        );
        const serverDefs = definitionsResponse.data || [];
        if (serverDefs.length > 0) {
          serverDefinition = serverDefs[0];
          targetServerName = serverDefinition.name;
        } else {
          // console.warn(
          //   `Relay: Target server ID "${targetServerId}" not found via ${definitionsUrl}. Relay may not function correctly.`
          // );
          targetServerId = undefined;
        }
      } catch (error: any) {
        console.error(
          `Relay: Failed to fetch server definition from ${definitionsUrl}. Error: ${error.message}. Relay will likely fail.`
        );
        targetServerId = undefined;
      }

      // Fetch resources list *if* server was found
      if (targetServerId) {
        // Check again in case it was cleared on error
        const resourcesListUrl = `${CENTRAL_SERVER_BASE_URL}/mcp/resources/list?serverId=${targetServerId}`;
        // console.log(
        //   `Relay: Fetching initial resource list from: ${resourcesListUrl}`
        // );
        try {
          const response = await axios.get<{ resources: Resource[] }>(
            resourcesListUrl,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );
          targetServerResources = response.data?.resources || [];
          // console.log(
          //   `Relay: Fetched ${targetServerResources.length} resources for static registration.`
          // );
        } catch (error: any) {
          console.error(
            `Relay: Failed to fetch initial resource list from ${resourcesListUrl}: ${error.message}`
          );
          // Continue without resources if list fetch fails?
        }
      }
    } else {
      // console.warn(
      //   `Relay: No targetServerId configured in ${configPath}. Tools will not be relayed.`
      // );
    }

    // --- Create McpServer instance ---
    const serverDisplayName = targetServerId
      ? targetServerName || `Relay for ${targetServerId.substring(0, 8)}...`
      : relayServerName;
    // console.error(
    //   `Relay: Creating McpServer instance with name: "${serverDisplayName}"`
    // );
    serverInstance = new McpServer({
      name: serverDisplayName,
      version: "1.0.0",
      capabilities: {
        // Enable resources capability if we fetched any resources to register
        resources: targetServerResources.length > 0 ? {} : undefined,
        tools:
          serverDefinition?.tools && serverDefinition.tools.length > 0
            ? {}
            : undefined,
      },
    });

    // --- Add SDK Error Listener (BEFORE handlers) ---
    if (!serverInstance) {
      throw new Error("Failed to create McpServer instance.");
    }
    // console.log("Relay: Adding generic error listener to SDK instance.");
    (serverInstance as any).onError = (error: any) => {
      console.error("Relay: SDK internal error caught: ", error);
    };

    // --- Define Factory for Read Handler ---
    const createReadHandler = (resourceUriRegistered: string) => {
      return async (
        uriFromSdk: URL,
        _params: any
      ): Promise<{ contents: any[] }> => {
        const requestedUri = uriFromSdk.href;
        // console.log(`Relay: Read handler called. SDK URI: ${requestedUri}`);
        if (!targetServerId) {
          throw new Error("Relay not configured...");
        }

        const readUrl = `${CENTRAL_SERVER_BASE_URL}/mcp/resources/read?uri=${encodeURIComponent(
          requestedUri
        )}`;
        // console.log(`Relay: Proxying read for ${requestedUri} to: ${readUrl}`);
        try {
          const response = await axios.get<{ contents: any[] }>(readUrl, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-MCP-Target-Server-ID": targetServerId,
            },
            // Set maxBodyLength to Infinity to avoid Axios limits, though unlikely the cause here
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          });
          // Directly return the received structure
          // console.log(`Relay: Returning result object to SDK for ${requestedUri}...`);
          return { contents: response.data?.contents || [] };
        } catch (error: any) {
          console.error(
            `Relay: Error proxying read for ${requestedUri} to ${readUrl}: ${error.message}`
          );
          if (axios.isAxiosError(error) && error.response) {
            console.error(
              `Relay: Upstream error: Status=${error.response.status}, Data=`,
              error.response.data
            );
            throw new Error(`Upstream server error: ${error.response.status}`);
          } else {
            throw new Error(
              `Failed to read resource ${requestedUri}: ${error.message}`
            );
          }
        }
        // Unreachable code below, errors are thrown or result is returned
      };
    };

    // --- Dynamically Register Tools ---
    if (serverDefinition?.tools && serverDefinition.tools.length > 0) {
      // console.log(
      //   `Relay: Registering ${serverDefinition.tools.length} tools for server ${targetServerId}...`
      // );
      for (const toolDef of serverDefinition.tools) {
        const sanitize = (name: string): string =>
          name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);
        const finalRegisteredName = sanitize(toolDef.name);
        const toolSlugToForward = toolDef.slug;

        if (!finalRegisteredName) {
          // console.warn(
          //   `Skipping tool registration due to empty sanitized name for tool ${toolDef.name}`
          // );
          continue;
        }

        const parameters: { [key: string]: ZodTypeAny } = {};
        if (toolDef.parameters && Array.isArray(toolDef.parameters)) {
          toolDef.parameters.forEach((param) => {
            let zodSchema: ZodTypeAny;
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
              default:
                zodSchema = z.any();
            }
            if (param.description) {
              zodSchema = zodSchema.describe(param.description);
            }
            if (!param.required) {
              zodSchema = zodSchema.optional();
            }
            parameters[param.name] = zodSchema;
          });
        }

        const handler = async (params: Record<string, any>) => {
          return await forwardToolCall(
            params,
            targetServerId!,
            toolSlugToForward
          );
        };

        // console.log(
        //   `Relay: Registering tool '${finalRegisteredName}' (forwards to slug '${toolSlugToForward}' on server ${targetServerId})`
        // );
        serverInstance.tool(
          finalRegisteredName,
          toolDef.description || "",
          parameters,
          handler
        );
      }
    } else {
      // console.log(
      //   `Relay: No tools to register for server ${
      //     targetServerId || "(none specified)"
      //   }.`
      // );
    }

    // --- Register Static Resources ---
    // console.log("Relay: Attempting to register static resources...");
    try {
      // Register each fetched resource individually using the correct factory
      if (targetServerResources.length > 0) {
        // console.log(
        //   `Relay: Registering ${targetServerResources.length} static resources...`
        // );
        for (const resource of targetServerResources) {
          // console.log(
          //   `Relay: Registering static resource: Name=${resource.name}, URI=${resource.uri}`
          // );
          // Use the factory to create a specific read handler for this URI
          serverInstance.resource(
            resource.name,
            resource.uri,
            createReadHandler(resource.uri)
          );
        }
        // console.log(`Relay: Finished registering static resources.`);
      } else {
        // console.log(
        //   "Relay: Skipping static resource registration as none were fetched."
        // );
      }
    } catch (e) {
      console.error("Relay: Error registering static resources:", e);
    }

    // --- Start Server ---
    // console.log(
    //   "Relay: Initialization complete. Starting StdioServerTransport..."
    // );
    const transport = new StdioServerTransport();
    await serverInstance.connect(transport);
    // console.log(`Relay: ${serverDisplayName} connected via Stdio.`);
  } catch (error: any) {
    // Catch errors during initialization or runtime
    console.error("Relay: Entered CATCH block in main(). Error:", error);
    let userFriendlyMessage = "Fatal error initializing MCP Local Relay:";

    // Check for specific stack overflow error
    if (
      error instanceof RangeError &&
      error.message.includes("Maximum call stack size exceeded")
    ) {
      userFriendlyMessage =
        `Fatal Error: Maximum call stack size exceeded. \n` +
        `This likely occurred while handling a large resource (e.g., image blob). \n` +
        `Try restarting the relay with an increased stack size using the --stack-size flag. \n` +
        `Example: node --stack-size=32768 dist/index.js \n` +
        `(See comments in src/index.ts for more details.)`;
    } else if (axios.isAxiosError(error)) {
      userFriendlyMessage += ` Failed to connect or process definitions from ${CENTRAL_SERVER_BASE_URL}. Ensure the central server is running and API key is valid. Error: ${error.message}`;
      if (error.response) {
        userFriendlyMessage += ` Server responded with status ${
          error.response.status
        }: ${JSON.stringify(error.response.data)}`;
      }
    } else {
      userFriendlyMessage += ` ${error.message}`;
    }
    console.error(userFriendlyMessage); // Log the tailored message
    // console.error(errorMessage, error); // Log the original error object too if needed for debugging
    process.exit(1);
  }
}

main().catch((error) => {
  // Keep final fatal error log
  if (
    !(
      error instanceof RangeError &&
      error.message.includes("Maximum call stack size exceeded")
    )
  ) {
    // Avoid double-logging the stack size error if it bubbles up here
    console.error("Unexpected fatal error in Relay main():", error);
  }
  process.exit(1);
});
