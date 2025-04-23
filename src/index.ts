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

// --- IMPORTANT STDIO TRANSPORT NOTE ---
// This relay uses StdioServerTransport by default. This means it communicates
// with the client (e.g., Claude Desktop, Inspector) via standard input and
// standard output (stdin/stdout).
//
// !!! DO NOT ADD `console.log` or `console.error` statements that write !!!
// !!! to STDOUT during the normal execution flow (initialization,        !!!
// !!! request handling). Doing so will corrupt the JSON-RPC message stream !!!
// !!! expected by the client, causing JSON parsing errors like          !!!
// !!! "Unexpected token ... is not valid JSON".                      !!!
//
// Use `console.error` only for *fatal* errors within catch blocks that lead
// to `process.exit(1)`.
// ----------------------------------------

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

// Point to the correct relay-specific server definitions endpoint under /mcp
const CENTRAL_SERVER_DISCOVERY_URL = `${CENTRAL_SERVER_BASE_URL}/mcp/servers`;

// Configuration file path
const configPath = path.resolve(__dirname, "../mcpconfig.json");

// --- Types ---
interface RelayConfig {
  targetServerId?: string;
}

// Matches the structure returned by /mcp/servers
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

// Prompt related types
interface PromptArgument {
  name: string;
  description: string | null;
  required: boolean;
}

interface PromptDefinition {
  name: string;
  description: string | null;
  arguments: PromptArgument[];
}

// --- Helper function to forward tool calls ---
async function forwardToolCall(
  parameters: Record<string, any>,
  serverId: string,
  toolSlug: string
): Promise<{ content: any[]; isError?: boolean }> {
  const executeUrl = `${CENTRAL_SERVER_BASE_URL}/mcp/servers/${serverId}/tools/${toolSlug}/execute`;

  try {
    const response = await axios.post<{ result: string; isError: boolean }>(
      executeUrl,
      parameters,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

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
        "Relay: Invalid response format from central server execution endpoint:"
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
    let errorMessage = `Error executing tool '${toolSlug}'.`;
    let detailText = "Relay failed to communicate with the execution server.";

    if (axios.isAxiosError(error)) {
      if (error.response) {
        errorMessage = `Error executing tool '${toolSlug}' (Status: ${error.response.status}).`;
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
      detailText = error.message;
    }

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
  let targetServerResources: Resource[] = [];
  let serverDefinition: RelayServerDefinition | null = null;
  let serverPrompts: PromptDefinition[] = [];

  try {
    // --- Read Configuration ---
    try {
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8");
        const config: RelayConfig = JSON.parse(configContent);
        targetServerId = config.targetServerId;
        if (targetServerId === "YOUR_SERVER_ID_HERE") {
          targetServerId = undefined;
        }
      }
    } catch (error: any) {
      console.error(`Relay: Error reading/parsing ${configPath}:`, error);
      targetServerId = undefined;
    }
    // --- End Configuration Reading ---

    // --- Fetch Definition AND Resources for Target Server ---
    if (targetServerId) {
      const definitionsUrl = `${CENTRAL_SERVER_BASE_URL}/mcp/servers?serverId=${targetServerId}`;
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
        try {
          const response = await axios.get<{ resources: Resource[] }>(
            resourcesListUrl,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );
          targetServerResources = response.data?.resources || [];
        } catch (error: any) {
          console.error(
            `Relay: Failed to fetch initial resource list from ${resourcesListUrl}: ${error.message}`
          );
        }
      }

      // Fetch prompts list *if* server was found
      if (targetServerId) {
        const promptsListUrl = `${CENTRAL_SERVER_BASE_URL}/mcp/prompts/list?serverId=${targetServerId}`;
        try {
          const response = await axios.post<{ prompts: PromptDefinition[] }>(
            promptsListUrl,
            {},
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
            }
          );
          serverPrompts = response.data?.prompts || [];
        } catch (error: any) {
          console.error(
            `Relay: Failed to fetch prompts list from ${promptsListUrl}: ${error.message}`
          );
        }
      }
    }

    // --- Create McpServer instance ---
    const serverDisplayName = targetServerId
      ? targetServerName || `Relay for ${targetServerId.substring(0, 8)}...`
      : relayServerName;
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
        // Enable prompts capability if we fetched any prompts
        prompts: serverPrompts.length > 0 ? {} : undefined,
      },
    });

    // --- Add SDK Error Listener (BEFORE handlers) ---
    if (!serverInstance) {
      throw new Error("Failed to create McpServer instance.");
    }

    // --- Define Factory for Read Handler ---
    const createReadHandler = (resourceUriRegistered: string) => {
      return async (
        uriFromSdk: URL,
        _params: any
      ): Promise<{ contents: any[] }> => {
        const requestedUri = uriFromSdk.href;
        if (!targetServerId) {
          throw new Error("Relay not configured...");
        }

        const readUrl = `${CENTRAL_SERVER_BASE_URL}/mcp/resources/read?uri=${encodeURIComponent(
          requestedUri
        )}`;
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
          const result = { contents: response.data?.contents || [] };
          return result;
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
      };
    };

    // --- Dynamically Register Tools ---
    if (serverDefinition?.tools && serverDefinition.tools.length > 0) {
      for (const toolDef of serverDefinition.tools) {
        const sanitize = (name: string): string =>
          name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 64);
        const finalRegisteredName = sanitize(toolDef.name);
        const toolSlugToForward = toolDef.slug;

        if (!finalRegisteredName) {
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

        serverInstance.tool(
          finalRegisteredName,
          toolDef.description || "",
          parameters,
          handler
        );
      }
    }

    // --- Register Static Resources ---
    try {
      if (targetServerResources.length > 0) {
        for (const resource of targetServerResources) {
          serverInstance.resource(
            resource.name,
            resource.uri,
            createReadHandler(resource.uri)
          );
        }
      }
    } catch (e) {
      console.error("Relay: Error registering static resources:", e);
    }

    // --- Register Prompts ---
    if (serverPrompts.length > 0 && targetServerId) {
      try {
        // Register each prompt
        for (const promptDef of serverPrompts) {
          // Convert the prompt arguments to Zod schema
          const promptParameters: Record<string, ZodTypeAny> = {};

          if (promptDef.arguments && Array.isArray(promptDef.arguments)) {
            promptDef.arguments.forEach((arg) => {
              // Default to string type for all arguments since we don't have type information
              let schema = z.string();

              if (arg.description) {
                schema = schema.describe(arg.description);
              }

              // Add the parameter with optional flag if needed
              promptParameters[arg.name] = arg.required
                ? schema
                : schema.optional();
            });
          }

          // Create a handler for the prompt
          const promptHandler = async (args: any) => {
            try {
              // Make a POST request to the real server to get the prompt data
              const response = await fetch(
                `${CENTRAL_SERVER_BASE_URL}/mcp/prompts/${promptDef.name}`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify(args),
                }
              );

              if (!response.ok) {
                throw new Error(
                  `Failed to fetch prompt: ${response.statusText}`
                );
              }

              const promptData = await response.json();
              return promptData;
            } catch (error) {
              console.error(`Error fetching prompt ${promptDef.name}:`, error);
              throw error;
            }
          };

          // Register the prompt with the server
          serverInstance.prompt(
            promptDef.name,
            promptDef.description || "",
            promptParameters,
            promptHandler
          );
        }
      } catch (error: any) {
        console.error(`Relay: Error registering prompts:`, error.message);
      }
    }

    // --- Start Server ---
    const transport = new StdioServerTransport();
    await serverInstance.connect(transport);
  } catch (error: any) {
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
    console.error(userFriendlyMessage);
    process.exit(1);
  }
}

main().catch((error) => {
  if (
    !(
      error instanceof RangeError &&
      error.message.includes("Maximum call stack size exceeded")
    )
  ) {
    console.error("Unexpected fatal error in Relay main():", error);
  }
  process.exit(1);
});
