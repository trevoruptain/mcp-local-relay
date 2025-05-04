import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Resource } from "@modelcontextprotocol/sdk/types";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z, ZodTypeAny } from "zod";

// Set up file logging
const logFilePath = path.resolve(__dirname, "../local-relay-debug.log");

// Create a simple logger that writes to file
function log(...args: any[]) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
    )
    .join(" ");

  const logMessage = `${timestamp} - ${message}\n`;

  // Append to log file - use sync to ensure it writes before any crashes
  try {
    fs.appendFileSync(logFilePath, logMessage);
  } catch (error) {
    // If we can't write to the log file, try console as a fallback
    // but only for severe errors to avoid corrupting the JSON-RPC stream
    console.error(`[ERROR WRITING TO LOG FILE] ${error}`);
  }
}

// Initialize the log file
try {
  log("---------- LOCAL RELAY LOG STARTED ----------");
  log(`Log file: ${logFilePath}`);
  log(`Node.js version: ${process.version}`);
  log(`Process ID: ${process.pid}`);
  log(`Current directory: ${process.cwd()}`);
} catch (error) {
  console.error("Failed to initialize log file:", error);
}

// Configure global error handling to catch and log unhandled errors
process.on("uncaughtException", (error) => {
  log("UNCAUGHT EXCEPTION (local-relay):", error);
  // Don't exit the process - we want to keep running despite errors
});

process.on("unhandledRejection", (reason, promise) => {
  log("UNHANDLED REJECTION (local-relay):", reason);
  // Don't exit the process - we want to keep running despite errors
});

// Add global fetch polyfill with better error handling
try {
  // Only add fetch if it doesn't already exist
  if (typeof global.fetch !== "function") {
    log("fetch not available, implementing with axios");

    // Create polyfill for fetch using axios
    global.fetch = async (url: string | URL | Request, options: any = {}) => {
      const requestUrl =
        url instanceof URL || typeof url === "string"
          ? url.toString()
          : url.url;
      log(`[fetch] Fetching URL: ${requestUrl}`);

      const requestInit =
        url instanceof Request
          ? { method: url.method, headers: url.headers }
          : options;

      try {
        const axiosOptions: any = {
          method: requestInit.method || "GET",
          url: requestUrl,
          responseType: "arraybuffer",
        };

        if (requestInit.headers) {
          axiosOptions.headers = {};
          if (requestInit.headers instanceof Headers) {
            requestInit.headers.forEach((value: string, key: string) => {
              axiosOptions.headers[key] = value;
            });
          } else {
            axiosOptions.headers = requestInit.headers;
          }
        }

        if (requestInit.body) {
          axiosOptions.data = requestInit.body;
        }

        const response = await axios(axiosOptions);

        const responseHeaders = new Headers();
        Object.entries(response.headers).forEach(
          ([key, value]: [string, any]) => {
            responseHeaders.set(key, String(value));
          }
        );

        return new Response(response.data, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        log(`[fetch] Error fetching ${requestUrl}:`, error);
        throw error;
      }
    };

    // Create Headers class to simulate browser Headers API
    class HeadersPolyfill {
      private headers: Record<string, string> = {};

      constructor(init?: Record<string, string>) {
        if (init) {
          Object.entries(init).forEach(([key, value]: [string, string]) => {
            this.set(key, value);
          });
        }
      }

      append(name: string, value: string): void {
        const existingValue = this.get(name);
        this.set(name, existingValue ? `${existingValue}, ${value}` : value);
      }

      delete(name: string): void {
        delete this.headers[name.toLowerCase()];
      }

      get(name: string): string | null {
        return this.headers[name.toLowerCase()] || null;
      }

      has(name: string): boolean {
        return name.toLowerCase() in this.headers;
      }

      set(name: string, value: string): void {
        this.headers[name.toLowerCase()] = value;
      }

      forEach(
        callback: (value: string, key: string, parent: HeadersPolyfill) => void
      ): void {
        Object.entries(this.headers).forEach(
          ([key, value]: [string, string]) => {
            callback(value, key, this);
          }
        );
      }
    }

    // @ts-ignore - Ignore type errors for our simple polyfill implementation
    global.Headers = HeadersPolyfill as any;

    // Create Request class with all required static properties
    const RequestClass = class Request {
      url: string;
      method: string;
      headers: any;

      constructor(input: string, init: any = {}) {
        this.url = input;
        this.method = init.method || "GET";
        this.headers = new global.Headers(init.headers);
      }
    };

    // Add required static properties
    RequestClass.prototype = RequestClass.prototype || {};

    // @ts-ignore - Ignore type errors for our simple polyfill implementation
    global.Request = RequestClass as any;

    log("Added axios-based fetch polyfill");
  } else {
    log("Global fetch already exists, skipping polyfill");
  }
} catch (error) {
  log("Failed to create axios-based fetch polyfill:", error);
  // Continue without fetch - better to try to run than crash immediately
}

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
  log("Starting MCP local-relay main function...");

  let serverInstance: McpServer | null = null;
  const relayServerName = "MCP Kit Relay";
  let targetServerId: string | undefined = undefined;
  let targetServerName: string | undefined = undefined;
  let targetServerResources: Resource[] = [];
  let serverDefinition: RelayServerDefinition | null = null;
  let serverPrompts: PromptDefinition[] = [];

  try {
    // --- Read Configuration ---
    log("Reading configuration...");
    try {
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, "utf-8");
        const config: RelayConfig = JSON.parse(configContent);
        targetServerId = config.targetServerId;
        if (targetServerId === "YOUR_SERVER_ID_HERE") {
          targetServerId = undefined;
        }
        log(`Loaded config with serverId: ${targetServerId || "undefined"}`);
      } else {
        log(`Config file not found at: ${configPath}`);
      }
    } catch (error: any) {
      log(
        `Relay: Error reading/parsing ${configPath}:`,
        error.message || error
      );
      targetServerId = undefined;
    }
    // --- End Configuration Reading ---

    // --- Fetch Definition AND Resources for Target Server ---
    if (targetServerId) {
      log(`Fetching server definition for server ID: ${targetServerId}`);
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
          log(`Found server: ${targetServerName}`);
        } else {
          log("No server definitions found");
          targetServerId = undefined;
        }
      } catch (error: any) {
        log(
          `Relay: Failed to fetch server definition from ${definitionsUrl}. Error: ${
            error.message || error
          }. Relay will likely fail.`
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

    log(`Creating MCP server with name: ${serverDisplayName}`);
    try {
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
      log("MCP server instance created successfully");
    } catch (error: any) {
      log(`ERROR creating MCP server: ${error.message || error}`);
      throw error;
    }

    // --- Add SDK Error Listener (BEFORE handlers) ---
    if (!serverInstance) {
      log("Server instance is null after creation");
      throw new Error("Failed to create McpServer instance.");
    }

    log("Setting up server capabilities");

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
          log(
            `Relay: Error proxying read for ${requestedUri} to ${readUrl}: ${error.message}`
          );
          if (axios.isAxiosError(error) && error.response) {
            log(
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
        log(`Registering ${targetServerResources.length} resources...`);
        for (const resource of targetServerResources) {
          log(`  - Registering resource: ${resource.name}`);
          serverInstance.resource(
            resource.name,
            resource.uri,
            createReadHandler(resource.uri)
          );
        }
        log("Resources registered successfully");
      } else {
        log("No resources to register");
      }
    } catch (e: any) {
      log("Relay: Error registering static resources:", e.message || e);
    }

    // --- Register Prompts ---
    if (serverPrompts.length > 0 && targetServerId) {
      try {
        log(`Registering ${serverPrompts.length} prompts...`);
        // Register each prompt
        for (const promptDef of serverPrompts) {
          log(`  - Registering prompt: ${promptDef.name}`);

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
          const promptHandler = async (args: any, extra: any = {}) => {
            try {
              // Enhanced debugging for arguments
              log(`DEBUG: Starting prompt handler for "${promptDef.name}"`);
              log(`DEBUG: Raw arguments: ${JSON.stringify(args)}`);
              log(`DEBUG: Raw extra: ${JSON.stringify(extra)}`);
              log(`DEBUG: Argument type: ${typeof args}`);
              log(
                `DEBUG: Arguments keys: ${Object.keys(args || {}).join(", ")}`
              );

              // Check if there's a 'params' object in the args (Claude might nest them)
              if (args && args.params && typeof args.params === "object") {
                log(`DEBUG: Found nested params object, extracting...`);
                const extractedArgs = args.params.arguments || {};
                log(
                  `DEBUG: Extracted nested arguments: ${JSON.stringify(
                    extractedArgs
                  )}`
                );
                args = extractedArgs;
              }

              // If args is a string, try to parse it to see if it's JSON
              if (typeof args === "string") {
                log(`DEBUG: Argument is a string, attempting to parse`);
                try {
                  const parsedArgs = JSON.parse(args);
                  log(`DEBUG: Parsed string args:`, JSON.stringify(parsedArgs));
                  // If parsing succeeds, use the parsed object
                  args = parsedArgs;
                } catch (e) {
                  log(`DEBUG: String arg is not valid JSON:`, args);
                }
              }

              // Make a POST request to the real server to get the prompt data
              let response;
              try {
                // Make sure we're passing the arguments correctly
                const requestData = {
                  params: {
                    name: promptDef.name,
                    arguments: args || {},
                  },
                };

                log(
                  `DEBUG: Sending request to server:`,
                  JSON.stringify(requestData)
                );

                response = await axios.post(
                  `${CENTRAL_SERVER_BASE_URL}/mcp/prompts/get?serverId=${targetServerId}`,
                  requestData,
                  {
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${apiKey}`,
                    },
                  }
                );
              } catch (requestError: any) {
                log(
                  `ERROR in prompt request for "${promptDef.name}":`,
                  requestError.message || "No error message"
                );
                throw requestError;
              }

              log(
                `DEBUG: Prompt handler response received for ${promptDef.name}`
              );

              // Check if response has the expected structure
              if (!response || !response.data) {
                log(
                  `ERROR: Invalid response from server for prompt "${promptDef.name}"`
                );
                throw new Error(
                  `Invalid response from server for prompt "${promptDef.name}"`
                );
              }

              // Debug log the entire response
              log(`Prompt response data for ${promptDef.name}:`, response.data);

              // CRITICAL: The MCP SDK expects the response in a specific format
              // Check and normalize to proper structure
              const originalData = response.data;
              let resultMessages = [];
              let resultDescription: string | undefined =
                promptDef.description || undefined;

              // Case 1: Server already returns the correct format (description + messages)
              if (
                originalData.messages &&
                Array.isArray(originalData.messages)
              ) {
                log(
                  `Server returned properly structured response with messages array`
                );
                resultMessages = originalData.messages;
                if (originalData.description) {
                  resultDescription = originalData.description;
                }
              }
              // Case 2: Server returns just an array of messages
              else if (Array.isArray(originalData)) {
                log(
                  `Server returned raw message array, reformatting to MCP spec`
                );
                resultMessages = originalData;
              }
              // Case 3: Unknown format - try to extract messages if possible
              else {
                log(
                  `WARNING: Unexpected response format, attempting to normalize`
                );

                // Try to extract messages if available, or use empty array
                resultMessages = Array.isArray(originalData.messages)
                  ? originalData.messages
                  : Array.isArray(originalData)
                  ? originalData
                  : [];

                if (originalData.description) {
                  resultDescription = originalData.description;
                }
              }

              // Create the final object structure expected by the MCP spec
              const result = {
                description: resultDescription,
                messages: resultMessages,
              };

              log(`Formatted response for prompt ${promptDef.name}:`, result);
              return result;
            } catch (error: any) {
              // Log the error to stderr (this will be visible in Claude logs)
              log(
                `Error in prompt handler for "${promptDef.name}":`,
                error.message || "No error message",
                error.stack || "No stack trace"
              );

              // Rethrow to be handled by MCP SDK
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
    log("Creating stdio transport...");
    try {
      const transport = new StdioServerTransport();

      log("Transport created, connecting server...");
      await serverInstance.connect(transport);
      log("Server connected successfully!");
    } catch (error: any) {
      log("Error connecting server to transport:", error.message || error);
      throw error;
    }
  } catch (error: any) {
    log("Relay: Entered CATCH block in main(). Error:", error.message || error);
    log("Stack trace:", error.stack || "No stack trace available");
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
    log(userFriendlyMessage);

    // For fatal errors we'll also write to console.error for visibility
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
    log("Unexpected fatal error in Relay main():", error);
    console.error("Unexpected fatal error in Relay main():", error);
  }
  process.exit(1);
});
