// Log this as early as possible
console.log(
  `[GLOBAL SCOPE EARLY CHECK] DYNAMODB_STATE_TABLE: '${process.env.DYNAMODB_STATE_TABLE}'`
);

const express = require("express");
const bodyParser = require("body-parser");
const { Client } = require("@notionhq/client"); // Import Notion Client
const OpenAI = require("openai"); // Import OpenAI Client
const { WebClient } = require("@slack/web-api"); // Import Slack WebClient
const crypto = require("crypto"); // Needed for signature verification
const awsServerlessExpress = require("aws-serverless-express");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb"); // Import AWS SDK v3 DynamoDB

const app = express();

// --- Environment Variable Configuration ---
// Port for the server to listen on
const PORT = process.env.PORT || 3000;
// Logging level (example)
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

// Helper function for logging based on LOG_LEVEL (simple version)
const logger = {
  debug: (message, ...args) => {
    if (LOG_LEVEL === "debug" || LOG_LEVEL === "verbose")
      console.debug(`[DEBUG] ${message}`, ...args);
  },
  info: (message, ...args) => {
    if (LOG_LEVEL !== "warn" && LOG_LEVEL !== "error")
      console.info(`[INFO] ${message}`, ...args);
  },
  warn: (message, ...args) => {
    if (LOG_LEVEL !== "error") console.warn(`[WARN] ${message}`, ...args);
  },
  error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
  tool: (toolName, message, ...args) => {
    if (LOG_LEVEL !== "warn" && LOG_LEVEL !== "error")
      console.log(`[MCP TOOL LOG: ${toolName}] ${message}`, ...args);
  },
};

// API Keys and Secrets (CRITICAL: Do NOT commit actual keys to version control)
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // OpenAI API Key
const DYNAMODB_STATE_TABLE = process.env.DYNAMODB_STATE_TABLE;

// Log its value again just before trying to use it for client init
logger.info(
  `[CLIENT INIT CHECK] Attempting to use DYNAMODB_STATE_TABLE: '${DYNAMODB_STATE_TABLE}' (raw from process.env: '${process.env.DYNAMODB_STATE_TABLE}')`
);

// Notion Database ID from environment variables
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Initialize Notion Client
let notion;
if (NOTION_API_KEY) {
  notion = new Client({ auth: NOTION_API_KEY });
  logger.info("Notion client initialized.");
} else {
  logger.warn(
    "NOTION_API_KEY is not set. Real Notion integration will be disabled."
  );
}

// Initialize OpenAI Client
let openai;
// Add extra logging here to confirm key presence at runtime inside Lambda
logger.info(
  `[OpenAI Init] Checking for OPENAI_API_KEY in environment: ${
    OPENAI_API_KEY ? "FOUND" : "MISSING"
  }`
);
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  logger.info("OpenAI client initialized.");
} else {
  logger.warn("OPENAI_API_KEY is not set. OpenAI features will be disabled.");
}

// Slack Web Client Initialization
let slackWebClient;
// Add extra logging here to confirm token presence at runtime inside Lambda
logger.info(
  `[Slack Init] Checking for SLACK_BOT_TOKEN in environment: ${
    SLACK_BOT_TOKEN ? "FOUND" : "MISSING"
  }`
);
if (SLACK_BOT_TOKEN) {
  slackWebClient = new WebClient(SLACK_BOT_TOKEN);
  logger.info("Slack WebClient initialized.");
} else {
  logger.warn(
    "SLACK_BOT_TOKEN is not set. Real Slack API calls (like getPermalink) will be disabled."
  );
}

// Log API key presence (for demonstration purposes ONLY)
// In a real app, you'd initialize SDKs with these.
logger.info(
  `SLACK_BOT_TOKEN ${SLACK_BOT_TOKEN ? "found" : "NOT FOUND"} in environment.`
);
logger.info(
  `SLACK_SIGNING_SECRET ${
    SLACK_SIGNING_SECRET ? "found" : "NOT FOUND"
  } in environment.`
);
logger.info(
  `NOTION_API_KEY ${NOTION_API_KEY ? "found" : "NOT FOUND"} in environment.`
);

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !NOTION_API_KEY) {
  logger.warn(
    "One or more API keys/secrets are missing. Real API calls would fail."
  );
}

// AWS SDK v3 DynamoDB Client Initialization
let docClient;
if (DYNAMODB_STATE_TABLE) {
  try {
    // The AWS SDK will automatically attempt to infer the region from environment variables
    // (AWS_REGION, AWS_DEFAULT_REGION) or the shared credentials/config files.
    // If running in Lambda, the region is typically available from the execution environment.
    // Explicitly set region: e.g., new DynamoDBClient({ region: "your-aws-region" });
    const dynamodbClient = new DynamoDBClient({});
    docClient = DynamoDBDocumentClient.from(dynamodbClient);
    logger.info("DynamoDB DocumentClient initialized successfully.");
  } catch (error) {
    logger.error("Failed to initialize DynamoDB DocumentClient:", error);
    // Depending on the application's resilience strategy,
    // you might want to handle this more gracefully or even prevent startup.
    // For now, it will log the error and proceed, and subsequent operations using docClient will fail.
  }
} else {
  logger.warn(
    "DYNAMODB_STATE_TABLE environment variable is not set. DynamoDB state persistence will be disabled."
  );
}

// General JSON body parser for most routes
app.use(bodyParser.json());

// Specific urlencoded parser for the Slack interactive endpoint, with raw body capture
const urlencodedParserForInteractive = bodyParser.urlencoded({
  extended: true,
  limit: "5mb",
  verify: (req, res, buf, encoding) => {
    try {
      req.rawBody = buf.toString(encoding || "utf8");
      logger.info(
        "[bodyParser verify] Raw body captured for Slack interactive endpoint signature verification."
      );
    } catch (e) {
      logger.error("[bodyParser verify] Error capturing rawBody:", e);
      // You might want to throw an error here or handle it, so verifySlackSignature doesn't use a missing/stale req.rawBody
      // For now, log and continue; verifySlackSignature should ideally check if req.rawBody exists.
    }
  },
});

// --- Mock Data Stores (In-memory for demo) ---
let notionPages = {}; // Store mock Notion pages: { "slack_permalink_id": { pageId: "...", url: "..." } }
let issueCounter = 0;

// --- Simple In-Memory State Store for Pending Interactions ---
// WARNING: This data is lost on server restart. Use a persistent store (DB, Redis, etc.) for production.
// let pendingInteractions = {}; // Key: original_message_ts, Value: { initialParsedInfoRaw, structuredSlackMessage, missingInfo, createdAt }
const PENDING_INTERACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (used for TTL calculation)

// Cleanup old pending interactions periodically
/* // REMOVED setInterval
setInterval(() => {
  const now = Date.now();
  for (const key in pendingInteractions) {
    if (
      now - pendingInteractions[key].createdAt >
      PENDING_INTERACTION_TIMEOUT_MS
    ) {
      logger.info(
        `[State Cleanup] Removing expired pending interaction for thread: ${key}`
      );
      delete pendingInteractions[key];
    }
  }
}, 60 * 1000); // Check every minute
*/ // REMOVED setInterval

// --- I. MCP Server: Tool Implementations (Mocks) ---
// These mocks DO NOT use the actual API keys yet.
// In a real implementation, you would initialize Slack/Notion SDKs here using the API keys.

// A. Slack Tools
const tools_slack = {
  // Real implementation would use SLACK_BOT_TOKEN for API calls
  // and SLACK_SIGNING_SECRET for verifying incoming webhook requests.
  receiveSlackIssueMessage_tool: async (slackMessagePayload) => {
    logger.tool(
      "Slack",
      "receiveSlackIssueMessage_tool called with:",
      slackMessagePayload
    );
    if (
      !slackMessagePayload ||
      !slackMessagePayload.user ||
      !slackMessagePayload.text ||
      !slackMessagePayload.channel ||
      !slackMessagePayload.ts
    ) {
      throw new Error("Invalid Slack message payload");
    }

    let permalink = `https://mock.your-workspace.slack.com/archives/${
      slackMessagePayload.channel
    }/p${slackMessagePayload.ts.replace(".", "")}`; // Fallback permalink

    // --- Temporarily bypassing getPermalink for debugging ---
    logger.warn(
      "[Slack Tool DEBUG] Bypassing chat.getPermalink, using fallback."
    );
    /* --- Start Bypass Block --- 
    if (slackWebClient) {
      try { // Add specific try/catch around the API call
        logger.info(`[Slack Tool] Attempting to fetch permalink for ts: ${slackMessagePayload.ts} in channel: ${slackMessagePayload.channel}`);
        const result = await slackWebClient.chat.getPermalink({
          channel: slackMessagePayload.channel,
          message_ts: slackMessagePayload.ts,
        });
        if (result.ok && result.permalink) {
          permalink = result.permalink;
          logger.tool(
            "Slack",
            "Successfully fetched real permalink:",
            permalink
          );
        } else {
          // Log specific error from Slack API if result not ok
          logger.warn(
            "[MCP TOOL LOG: Slack] Slack API returned !result.ok for getPermalink. Error:",
            result.error || "Unknown error",
            "Falling back to mock permalink."
          );
        }
      } catch (error) {
        // Catch errors during the API call itself (network, auth etc.)
        logger.error(
          "[MCP TOOL ERROR: Slack] Error calling chat.getPermalink:",
          error.message || error // Log the actual error
        );
        logger.warn("[MCP TOOL LOG: Slack] Falling back to mock permalink due to error.");
        // Keep fallback permalink on error, allow function to continue
      }
    } else {
      logger.warn(
        "[MCP TOOL LOG: Slack] Slack WebClient not initialized. Using fallback permalink."
      );
    }
    --- End Bypass Block --- */

    logger.info(
      `[Slack Tool] Returning structured message with permalink: ${permalink}`
    ); // Add log before return
    return {
      userId: slackMessagePayload.user,
      text: slackMessagePayload.text,
      channelId: slackMessagePayload.channel,
      timestamp: slackMessagePayload.ts,
      attachments: slackMessagePayload.attachments || [],
      permalink: permalink,
    };
  },
  postSlackReply_tool: async ({
    channelId,
    messageText,
    threadTimestamp,
    blocks,
  }) => {
    logger.tool(
      "Slack",
      `postSlackReply_tool: Replying to channel ${channelId} (Thread: ${
        threadTimestamp || "N/A"
      }): \"${messageText}\"${blocks ? " with blocks" : ""}`
    );
    if (slackWebClient) {
      try {
        const result = await slackWebClient.chat.postMessage({
          channel: channelId,
          text: messageText, // Pass the fallback text
          blocks: blocks, // Pass the blocks if they exist
          thread_ts: threadTimestamp,
        });
        return {
          success: result.ok,
          messageId: result.ts,
          channel: channelId,
          text: messageText,
        };
      } catch (error) {
        logger.error("[MCP TOOL ERROR: Slack] Error posting reply:", error);
        return {
          success: false,
          error: error.message,
          channel: channelId,
          text: messageText,
        };
      }
    } else {
      // Fallback mock
      return {
        success: true,
        messageId: `slack_reply_ts_${Date.now()}`,
        channel: channelId,
        text: messageText,
        blocks: blocks, // Include blocks in mock response if provided
      };
    }
  },
};

// B. Notion Tools
const tools_notion = {
  createNotionPage_tool: async ({ targetDatabaseId, pageProperties }) => {
    if (!notion) {
      logger.warn(
        "[MCP TOOL LOG: Notion] Notion SDK not initialized. Using mock createNotionPage_tool."
      );
      issueCounter++;
      const pageId = `mock_notion_page_id_${issueCounter}`;
      const pageUrl = `https://www.notion.so/mock/${targetDatabaseId}/${pageId}`;
      return { pageId, url: pageUrl, ...pageProperties }; // Return structure similar to real API
    }
    logger.tool(
      "Notion",
      `createNotionPage_tool: Creating page in DB ${targetDatabaseId} with properties:`,
      pageProperties
    );
    try {
      const response = await notion.pages.create({
        parent: { database_id: targetDatabaseId },
        properties: pageProperties,
      });
      logger.tool("Notion", "Page created successfully:", response);
      return {
        pageId: response.id,
        url: response.url,
        properties: response.properties,
      };
    } catch (error) {
      logger.error(
        "[MCP TOOL ERROR: Notion] Failed to create Notion page:",
        error.body || error.message
      );
      throw new Error(`Notion API error creating page: ${error.message}`);
    }
  },
  findNotionPageBySlackLink_tool: async ({ slackMessagePermalink }) => {
    if (!notion) {
      logger.warn(
        "[MCP TOOL LOG: Notion] Notion SDK not initialized. Using mock findNotionPageBySlackLink_tool."
      );
      // Mock search (from previous implementation, kept for fallback)
      const foundPage = notionPages[slackMessagePermalink];
      if (foundPage) return { pageId: foundPage.id, url: foundPage.url };
      return null;
    }
    logger.tool(
      "Notion",
      `findNotionPageBySlackLink_tool: Searching for Slack permalink: ${slackMessagePermalink} in DB: ${NOTION_DATABASE_ID}`
    );
    try {
      const response = await notion.databases.query({
        database_id: NOTION_DATABASE_ID,
        filter: {
          property: "Link to Slack Message", // IMPORTANT: Assumes this property exists in your DB and is of type URL
          url: {
            equals: slackMessagePermalink,
          },
        },
      });
      if (response.results.length > 0) {
        const page = response.results[0];
        logger.tool("Notion", `Found existing page:`, {
          pageId: page.id,
          url: page.url,
        });
        return { pageId: page.id, url: page.url };
      }
      logger.tool("Notion", `No page found for this Slack permalink.`);
      return null;
    } catch (error) {
      logger.error(
        "[MCP TOOL ERROR: Notion] Failed to find Notion page by Slack link:",
        error.body || error.message
      );
      throw new Error(`Notion API error finding page: ${error.message}`);
    }
  },
  updateNotionPage_tool: async ({ pageId, propertiesToUpdate }) => {
    if (!notion) {
      logger.warn(
        "[MCP TOOL LOG: Notion] Notion SDK not initialized. Using mock updateNotionPage_tool."
      );
      // Mock update (from previous implementation, kept for fallback)
      let updated = false;
      for (const key in notionPages) {
        if (notionPages[key].id === pageId) {
          notionPages[key].properties = {
            ...notionPages[key].properties,
            ...propertiesToUpdate,
          };
          notionPages[key].last_edited_time = new Date().toISOString();
          updated = true;
          break;
        }
      }
      if (!updated) return { success: false, error: "Mock page not found" };
      return { success: true, pageId, updatedProperties: propertiesToUpdate };
    }
    logger.tool(
      "Notion",
      `updateNotionPage_tool: Updating page ${pageId} with:`,
      propertiesToUpdate
    );
    try {
      const response = await notion.pages.update({
        page_id: pageId,
        properties: propertiesToUpdate,
      });
      logger.tool("Notion", "Page updated successfully:", response);
      return {
        success: true,
        pageId: response.id,
        updatedProperties: response.properties,
      };
    } catch (error) {
      logger.error(
        "[MCP TOOL ERROR: Notion] Failed to update Notion page:",
        error.body || error.message
      );
      throw new Error(`Notion API error updating page: ${error.message}`);
    }
  },
};

// C. Triage & Processing Tools
const tools_processing = {
  parseIssueFromSlackText_tool: async ({ rawSlackText, attachments }) => {
    logger.tool(
      "Processing",
      "parseIssueFromSlackText_tool called with text:",
      rawSlackText
    );
    // Fallback parsing (if OpenAI fails or is disabled)
    let title =
      rawSlackText.substring(0, 70) + (rawSlackText.length > 70 ? "..." : "");
    let rootCause = "N/A";
    let priority = "Medium";
    let pictureUrl =
      attachments && attachments.length > 0
        ? attachments[0].image_url ||
          attachments[0].thumb_url ||
          "simulated_pic_url.jpg"
        : "No picture attached";
    // Basic extraction logic (already present)
    // ...

    const structuredDataFallback = {
      Title: title,
      Description: rawSlackText,
      RootCause: rootCause, // Will be UNKNOWN_ROOT_CAUSE from LLM if not found
      IssueType: "Task", // Will be UNKNOWN_ISSUE_TYPE from LLM
      Priority: priority, // Will be UNKNOWN_PRIORITY from LLM
      SuccessCriteria: "N/A", // Will be UNKNOWN_SUCCESS_CRITERIA from LLM
      Resolution: "N/A", // Will be UNKNOWN_RESOLUTION from LLM
      PictureURL: pictureUrl,
      originalText: rawSlackText,
    };

    if (openai) {
      const prompt = `You are an expert issue triage assistant. Your task is to analyze a Slack message and extract structured information for creating an issue in a Notion tracker. Output a valid JSON object with the following keys:

- Title: (String) A concise summary of the main problem or request, typically 5-15 words. If a clear title cannot be derived, use "UNKNOWN_TITLE". Sentence case.
- Description: (String) The full, verbatim text of the original Slack message. This will be used as the primary description content.
- RootCause: (String) If the message explicitly mentions a root cause, extract it. If the user states the root cause is unknown, unclear, or similar, use "Unclear". If not mentioned at all, use "UNKNOWN_ROOT_CAUSE". If the user explicitly states "N/A", use "N/A".
- IssueType: (String) Categorize into one of: "Bug", "Incident", "Task", "Test". If not clearly inferable from the message content, use "UNKNOWN_ISSUE_TYPE".
- Priority: (String) Categorize into one of: "High", "Medium", "Low". If not clearly inferable, use "UNKNOWN_PRIORITY".
- SuccessCriteria: (String) If the message specifies success criteria or definition of done, extract it. If not mentioned, use "UNKNOWN_SUCCESS_CRITERIA". If the user explicitly states "N/A", use "N/A".
- Resolution: (String) If the message specifies a resolution or fix, extract it. If not mentioned, use "UNKNOWN_RESOLUTION". If the user explicitly states "N/A", use "N/A".
- MentionedImageURL: (String) If the user pastes a URL to an image directly in the message text, extract that URL. Otherwise, use "NO_MENTIONED_IMAGE_URL". (Note: Actual attached files are handled separately by the system).

IMPORTANT:
- Adhere strictly to the specified values for "UNKNOWN_*" or "NO_MENTIONED_IMAGE_URL" when information is not available or applicable. Do not invent information.
- The output MUST be a single, valid JSON object and nothing else.

Examples:
1. Slack Message: "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module"
   Output:
   {
     "Title": "Cannot get valve to open on adsorb side of module",
     "Description": "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module",
     "RootCause": "UNKNOWN_ROOT_CAUSE", 
     "IssueType": "Bug",
     "Priority": "High",
     "SuccessCriteria": "UNKNOWN_SUCCESS_CRITERIA",
     "Resolution": "UNKNOWN_RESOLUTION",
     "MentionedImageURL": "NO_MENTIONED_IMAGE_URL"
   }
2. Slack Message: "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment. See screenshot at http://example.com/login_error.png"
   Output:
   {
     "Title": "Login page down for all users",
     "Description": "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment. See screenshot at http://example.com/login_error.png",
     "RootCause": "Database migration failed.",
     "IssueType": "Incident",
     "Priority": "High",
     "SuccessCriteria": "Users can log in again.",
     "Resolution": "Rolled back the faulty deployment.",
     "MentionedImageURL": "http://example.com/login_error.png"
   }
3. Slack Message: "The pump is making a weird noise again. We fixed it by restarting the controller. Not sure what criteria for success would be, N/A for now. Root cause is totally unknown."
    Output:
    {
      "Title": "Pump is making a weird noise",
      "Description": "The pump is making a weird noise again. We fixed it by restarting the controller. Not sure what criteria for success would be, N/A for now. Root cause is totally unknown.",
      "RootCause": "Unclear",
      "IssueType": "Bug",
      "Priority": "UNKNOWN_PRIORITY",
      "SuccessCriteria": "N/A",
      "Resolution": "Fixed by restarting the controller.",
      "MentionedImageURL": "NO_MENTIONED_IMAGE_URL"
    }
4. Slack Message: "Need to order more coffee."
    Output:
    {
        "Title": "Order more coffee",
        "Description": "Need to order more coffee.",
        "RootCause": "UNKNOWN_ROOT_CAUSE",
        "IssueType": "Task",
        "Priority": "UNKNOWN_PRIORITY",
        "SuccessCriteria": "UNKNOWN_SUCCESS_CRITERIA",
        "Resolution": "UNKNOWN_RESOLUTION",
        "MentionedImageURL": "NO_MENTIONED_IMAGE_URL"
   }

Slack Message to parse:
${rawSlackText}

JSON Output:
`;

      try {
        logger.info("[OpenAI Tool] Attempting to call chat.completions.create");
        const response = await openai.chat.completions.create({
          model: "gpt-4.1-2025-04-14", // Or your preferred model
          messages: [{ role: "user", content: prompt }],
        });
        // Add log upon successful return BEFORE parsing
        logger.info(
          "[OpenAI Tool] Successfully received response from chat.completions.create"
        );
        logger.tool(
          "Processing",
          "Parsed data from OpenAI:",
          response.choices[0].message.content
        );
        // Add specific catch for JSON parsing error
        try {
          return JSON.parse(response.choices[0].message.content);
        } catch (parseError) {
          logger.error(
            "[OpenAI Tool ERROR] Failed to parse JSON response from OpenAI:",
            parseError
          );
          logger.error(
            "[OpenAI Tool ERROR] Raw OpenAI response content:",
            response.choices[0].message.content
          );
          logger.warn(
            "Falling back to basic parsing due to OpenAI JSON parse error."
          );
          return structuredDataFallback;
        }
      } catch (error) {
        // Catch errors during the API call itself
        logger.error(
          "[MCP TOOL ERROR: OpenAI] Error calling chat.completions.create:",
          error.message || error // Log the actual error message
        );
        // Also log the error stack if available
        if (error.stack) {
          logger.error("[MCP TOOL ERROR: OpenAI] Stack trace:", error.stack);
        }
        logger.warn(
          "Falling back to basic parsing due to OpenAI API call error."
        );
        return structuredDataFallback; // Fallback on error
      }
    } else {
      logger.warn(
        "OpenAI client not initialized. Using mock/fallback parseIssueFromSlackText_tool."
      );
      return structuredDataFallback;
    }
  },
  determineTriageCategory_tool: async ({ structuredIssueData }) => {
    logger.tool(
      "Processing",
      "determineTriageCategory_tool called with:",
      structuredIssueData
    );
    const targetDatabaseId = NOTION_DATABASE_ID; // Single DB ID

    // Use values parsed by LLM if available
    let issueType =
      structuredIssueData["Issue Type"] ||
      structuredIssueData.issueType ||
      structuredIssueData.type ||
      "";
    let priority =
      structuredIssueData.Priority || structuredIssueData.priority || "";

    const text = (structuredIssueData.originalText || "").toLowerCase();

    // Infer Issue Type if not provided
    if (!issueType) {
      if (text.includes("bug")) {
        issueType = "Bug";
      } else if (
        text.includes("incident") ||
        text.includes("issue") ||
        text.includes("problem")
      ) {
        issueType = "Incident";
      } else if (text.includes("task")) {
        issueType = "Task";
      } else if (text.includes("test") || text.includes("qa")) {
        issueType = "Test";
      } else {
        issueType = "Task"; // Fallback
      }
    }

    // Infer Priority if not provided
    if (!priority) {
      if (/\b(high|critical|urgent|p0|p1)\b/.test(text)) {
        priority = "High";
      } else if (/\b(low|minor|p3|p4)\b/.test(text)) {
        priority = "Low";
      } else if (/\b(?:medium|p2)\b/.test(text)) {
        priority = "Medium";
      } else if (issueType === "Bug" || issueType === "Incident") {
        // Default escalate if severe type
        priority = "High";
      } else {
        priority = "Medium";
      }
    }

    const triageResult = { targetDatabaseId, issueType, priority };
    logger.tool("Processing", "Triage result:", triageResult);
    return triageResult;
  },
  parseAnswersAndUpdate_tool: async ({
    userReplyText,
    originalParsedInfo,
    questionsAsked,
  }) => {
    logger.tool(
      "Processing",
      "parseAnswersAndUpdate_tool called with reply:",
      userReplyText,
      "Original Data:",
      originalParsedInfo,
      "Questions:",
      questionsAsked
    );

    if (!openai) {
      logger.warn(
        "OpenAI client not initialized. Cannot parse answers. Returning original data."
      );
      return originalParsedInfo; // Cannot proceed without LLM
    }

    const questionList = questionsAsked
      .map((q) => `- ${q.displayName} (${q.parsedKey}): ${q.question}`)
      .join("\n");
    const originalJson = JSON.stringify(originalParsedInfo, null, 2);

    const prompt = `You are an AI assistant tasked with updating a JSON object containing issue details based ONLY on the user\'s reply to specific questions.

Original JSON data:
\`\`\`json
${originalJson}
\`\`\`

The user was specifically asked for clarification on the following fields (internal key in parentheses):
${questionList}

The user\'s latest reply is: "${userReplyText}"

Your Task: Update the original JSON data.
1.  Carefully examine the user\'s reply ("${userReplyText}").
2.  For **each** field listed in the "asked for clarification" list above:
    a.  Determine if the user\'s reply provides a **direct answer or relevant information** for that specific field.
    b.  If it does, update the corresponding value in the JSON object with the information extracted **strictly from the user\'s reply**.
    c.  If the user\'s reply does **not** contain information relevant to that specific asked field, **leave the original value unchanged** in the JSON object (it might be an "UNKNOWN_*" placeholder or a previously provided value like "N/A").
3.  **Crucially, do not update any fields that were NOT in the "asked for clarification" list.** Their values must remain exactly as they were in the original JSON.
4.  If the user says something like "that\'s all I know" or "no other details", do not change any existing "UNKNOWN_*" values unless they directly answered one of the asked questions in the same message.

Output ONLY the complete, updated, valid JSON object. Do not include explanations or any surrounding text.
`;
    logger.info(
      `[OpenAI Tool] Constructed prompt for parseAnswersAndUpdate_tool. Length: ${prompt.length}. About to call API.`
    );

    try {
      logger.info(
        "[OpenAI Tool] Attempting to call chat.completions.create for parseAnswersAndUpdate_tool"
      );
      const response = await openai.chat.completions.create({
        model: "gpt-4.1-2025-04-14", // Or your preferred model
        messages: [{ role: "user", content: prompt }],
      });
      logger.info(
        "[OpenAI Tool] Successfully received response from chat.completions.create for parseAnswersAndUpdate_tool"
      );
      const updatedJsonString = response.choices[0].message.content;
      logger.tool(
        "Processing",
        "Updated parsed data from OpenAI (parseAnswersAndUpdate_tool):",
        updatedJsonString
      );
      // Basic validation: Try parsing and check if it\'s an object
      const extractedJsonString = extractJson(updatedJsonString);
      const updatedParsedInfo = JSON.parse(extractedJsonString);
      if (typeof updatedParsedInfo !== "object" || updatedParsedInfo === null) {
        throw new Error("LLM did not return a valid JSON object.");
      }
      return updatedParsedInfo;
    } catch (error) {
      logger.error(
        "[MCP TOOL ERROR: OpenAI] Failed to parse answers and update data (parseAnswersAndUpdate_tool):",
        error.body || error.message,
        error.stack // Log stack trace
      );
      logger.warn(
        "Returning original data due to error parsing answers (parseAnswersAndUpdate_tool)."
      );
      return originalParsedInfo; // Return original on error
    }
  },
};

// Helper function to extract JSON block from potential markdown
const extractJson = (text) => {
  const match = text.match(/```(?:json)?\n([\s\S]*?)\n```/);
  if (match && match[1]) {
    return match[1];
  }
  // Fallback: assume the whole text might be JSON if no markdown fences found
  return text.trim();
};

const NOTION_PROPERTY_PROFILES = {
  Title: {
    parsedKey: "Title",
    displayName: "Title",
    isAdequate: (value) =>
      value && value.trim() !== "" && value !== "UNKNOWN_TITLE",
    question: "What would be a concise title for this issue?",
  },
  IssueType: {
    parsedKey: "IssueType",
    displayName: "Issue Type",
    isAdequate: (value) => value && !value.startsWith("UNKNOWN_"), // Will be one of Bug, Task, Incident, Test
    question: "What type of issue is this? (e.g., Bug, Task, Incident, Test)",
  },
  Priority: {
    parsedKey: "Priority",
    displayName: "Priority",
    isAdequate: (value) => value && !value.startsWith("UNKNOWN_"), // Will be one of High, Medium, Low
    question: "What is the priority for this? (High, Medium, or Low)",
  },
  SuccessCriteria: {
    parsedKey: "SuccessCriteria",
    displayName: "Success Criteria",
    // Consider adequate if user explicitly said N/A, or if it's filled. Ask if LLM is unsure (UNKNOWN_).
    isAdequate: (value) => value && value !== "UNKNOWN_SUCCESS_CRITERIA",
    question:
      "What are the success criteria for resolving this? (If none, say 'N/A')",
  },
  // Example of how you might add Root Cause if you wanted to prompt for it
  RootCause: {
    parsedKey: "RootCause",
    displayName: "Root Cause",
    // Ask if the LLM couldn't determine it (UNKNOWN_). Allow "Unclear" or "N/A" as valid answers.
    isAdequate: (value) => value && value !== "UNKNOWN_ROOT_CAUSE",
    question:
      "What is the suspected root cause? (If unknown, okay to say 'Unknown' or 'N/A')",
  },
};

// --- MCP Server: Exposing Tools via API Endpoints (Example) ---
app.post("/tools/slack/postReply", async (req, res) => {
  try {
    // In a real app, you might add authentication/authorization here for tool usage.
    const result = await tools_slack.postSlackReply_tool(req.body);
    res.json(result);
  } catch (error) {
    logger.error("Error in postSlackReply tool:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/tools/notion/createPage", async (req, res) => {
  try {
    const result = await tools_notion.createNotionPage_tool(req.body);
    res.json(result);
  } catch (error) {
    logger.error("Error in createNotionPage tool:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- II. MCP Client: Orchestration Logic ---

// Endpoint for Slack Events API (Messages, etc.)
app.post("/webhook/slack/event", async (req, res) => {
  // This log should now definitively tell us the state of docClient and the env var as seen by the handler
  logger.info(
    `[SLACK EVENT HANDLER ENTRY] docClient is ${
      docClient ? "DEFINED" : "UNDEFINED"
    }. DYNAMODB_STATE_TABLE env var is: '${
      process.env.DYNAMODB_STATE_TABLE
    }' (variable DYNAMODB_STATE_TABLE in global scope is: '${DYNAMODB_STATE_TABLE}')`
  );

  const slackEventPayload = req.body;
  // logger.debug(\`[RAW SLACK EVENT] ${JSON.stringify(slackEventPayload)}\`); // Very verbose

  // Basic validation and type check
  if (!slackEventPayload || typeof slackEventPayload !== "object") {
    logger.warn("[MCP CLIENT LOG] Invalid or empty payload received.");
    return res.status(400).send("Invalid payload.");
  }

  // Slack URL Verification Challenge
  // (Handle this early and separately)
  if (slackEventPayload.type === "url_verification") {
    logger.info(
      "[MCP CLIENT LOG] Responding to Slack URL verification challenge."
    );
    return res.status(200).send(slackEventPayload.challenge);
  }

  // We only care about event_callback carrying a message event
  if (
    slackEventPayload.type === "event_callback" &&
    slackEventPayload.event &&
    slackEventPayload.event.type === "message"
  ) {
    // Filter out messages from bots (including our own), or message changes/deletions
    if (
      slackEventPayload.event.bot_id ||
      slackEventPayload.event.subtype === "bot_message" ||
      slackEventPayload.event.subtype === "message_changed" ||
      slackEventPayload.event.subtype === "message_deleted"
    ) {
      logger.info(
        `[MCP CLIENT LOG] Ignoring event with subtype: ${
          slackEventPayload.event.subtype || "bot_id event"
        }`
      );
      return res.status(200).send("Ignoring event due to subtype.");
    }

    const messagePayload = slackEventPayload.event;
    // Use the thread_ts if available (message is in a thread), otherwise use the message's own ts.
    // This contextIdentifier will key the pending interaction.
    const contextIdentifier = messagePayload.thread_ts || messagePayload.ts;

    logger.info(
      `[MCP CLIENT LOG] Processing message event for context: ${contextIdentifier} (Message TS: ${messagePayload.ts}, Thread TS: ${messagePayload.thread_ts})`
    );

    // --- Check if this message is part of an ongoing interaction context ---
    let interactionState = null;
    if (docClient) {
      // Only attempt DB interaction if client initialized
      try {
        const getCommand = new GetCommand({
          TableName: DYNAMODB_STATE_TABLE,
          Key: { contextIdentifier },
        });
        const { Item } = await docClient.send(getCommand);
        if (Item) {
          // Check TTL (optional, as DynamoDB TTL handles deletion, but good for immediate feedback)
          const nowInSeconds = Math.floor(Date.now() / 1000);
          if (Item.ttl && Item.ttl < nowInSeconds) {
            logger.warn(
              `[State Store] Found expired state for context ${contextIdentifier} in DynamoDB (TTL expired). Ignoring.`
            );
            // Optionally delete it immediately
            const deleteCommand = new DeleteCommand({
              TableName: DYNAMODB_STATE_TABLE,
              Key: { contextIdentifier },
            });
            await docClient.send(deleteCommand); // Fire-and-forget delete is okay here
          } else {
            interactionState = Item; // Assign retrieved state
            logger.info(
              `[State Store] Retrieved active state for context ${contextIdentifier} from DynamoDB.`
            );
          }
        } else {
          logger.info(
            `[State Store] No active state found for context ${contextIdentifier} in DynamoDB.`
          );
        }
      } catch (error) {
        logger.error(
          `[State Store ERROR] Failed to get state for ${contextIdentifier} from DynamoDB:`,
          error
        );
        // Decide how to handle DB errors - potentially notify user and exit
        return res.status(500).json({
          success: false,
          error: "Failed to retrieve interaction state.",
        });
      }
    } else {
      logger.warn(
        "[State Store] DynamoDB client not available. Cannot process replies requiring state."
      );
      // Cannot reliably handle replies without state
      return res
        .status(500)
        .json({ success: false, error: "State management is disabled." });
    }

    if (interactionState) {
      // Modified check: Use the retrieved state
      // const interactionState = pendingInteractions[contextIdentifier]; // REMOVED
      logger.info(
        `[MCP CLIENT LOG] Received reply for tracked context: ${contextIdentifier}`
      );

      // --- Process Reply using retrieved interactionState ---
      try {
        const userReplyText = messagePayload.text;
        logger.info(
          `[MCP CLIENT LOG] Processing reply: "${userReplyText}" for context ${contextIdentifier}`
        );

        // Note: interactionState contains the data previously stored (initialParsedInfoRaw etc.)
        const originalDataBeforeUpdate = interactionState.initialParsedInfoRaw;
        logger.info(
          `[MCP CLIENT LOG] About to call parseAnswersAndUpdate_tool for context ${contextIdentifier}. Questions asked: ${JSON.stringify(
            interactionState.missingInfo.map((q) => q.displayName)
          )}`
        );
        const updatedData = await tools_processing.parseAnswersAndUpdate_tool({
          userReplyText: userReplyText,
          originalParsedInfo: originalDataBeforeUpdate,
          questionsAsked: interactionState.missingInfo,
        });
        logger.info(
          `[MCP CLIENT LOG] Returned from parseAnswersAndUpdate_tool for context ${contextIdentifier}. Data is ${
            updatedData === originalDataBeforeUpdate
              ? "UNCHANGED"
              : "potentially changed"
          }.`
        );

        // Check if the LLM tool failed (returned the exact same object reference)
        if (
          updatedData === originalDataBeforeUpdate &&
          userReplyText.trim() !== ""
        ) {
          logger.warn(
            `[MCP CLIENT LOG] parseAnswersAndUpdate_tool returned original data for context ${contextIdentifier}. User reply might not have been processed due to LLM error.`
          );
          // Inform user and wait for another reply, don't change state or re-ask.
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText:
              ":warning: I had trouble processing your last reply. Could you please try rephrasing or ensure it directly answers the questions I asked?",
            threadTimestamp: contextIdentifier,
          });
          return; // Stop processing this reply, wait for user to try again.
        }

        // If processing seemed successful, update the state
        interactionState.initialParsedInfoRaw = updatedData; // Update the local copy

        let stillMissingInfo = [];
        for (const profileName in NOTION_PROPERTY_PROFILES) {
          const profile = NOTION_PROPERTY_PROFILES[profileName];
          const value =
            interactionState.initialParsedInfoRaw[profile.parsedKey];
          if (!profile.isAdequate(value)) {
            stillMissingInfo.push(profile);
          }
        }
        interactionState.missingInfo = stillMissingInfo; // Update local copy

        if (interactionState.missingInfo.length > 0) {
          logger.info(
            `[MCP CLIENT LOG] Context ${contextIdentifier}: Still missing info, asking again:`,
            interactionState.missingInfo.map((p) => ({
              field: p.displayName,
              question: p.question,
            }))
          );

          // Update state in DynamoDB with new missingInfo and refreshed TTL
          interactionState.createdAt = Date.now(); // Update timestamp for TTL calculation
          const ttlTimestamp = Math.floor(
            (interactionState.createdAt + PENDING_INTERACTION_TIMEOUT_MS) / 1000
          );
          const putCommand = new PutCommand({
            TableName: DYNAMODB_STATE_TABLE,
            Item: {
              ...interactionState, // Store the whole updated state object
              contextIdentifier, // Ensure key is present
              ttl: ttlTimestamp, // Add TTL attribute
            },
          });
          await docClient.send(putCommand);
          logger.info(
            `[State Store] Updated state in DynamoDB for context ${contextIdentifier} with TTL ${ttlTimestamp}.`
          );

          const blocks = buildMissingInfoBlocks(
            interactionState.missingInfo,
            interactionState.initialParsedInfoRaw
          );
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText: "Thanks for the update! Still need a bit more info:",
            blocks: blocks,
            threadTimestamp: contextIdentifier, // Reply in the same context thread
          });
          logger.info(
            `[MCP CLIENT LOG] Re-asked for info in context ${contextIdentifier}.`
          );
        } else {
          // All info gathered, proceed to Notion AND delete state from DynamoDB
          logger.info(
            `[MCP CLIENT LOG] All info gathered for context ${contextIdentifier} via reply. Proceeding to Notion.`
          );
          await processAndCreateNotionPage(
            interactionState.initialParsedInfoRaw,
            interactionState.structuredSlackMessage, // Contains original message permalink, specific ts
            null, // Pass null for interactionState? Or maybe just relevant IDs? Check function.
            contextIdentifier // Pass the key for cleanup
          );
          // Cleanup handled within processAndCreateNotionPage (now includes DynamoDB delete)
        }
      } catch (error) {
        logger.error(
          `[MCP CLIENT ERROR] Failed to process user reply for context ${contextIdentifier}:`,
          error,
          error.stack // Log stack trace
        );
        try {
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel, // channel from original payload
            messageText: `:x: Sorry, I encountered an error trying to process your reply: ${error.message}`,
            threadTimestamp: contextIdentifier, // Post error in the context thread
          });
        } catch (slackError) {
          logger.error(
            `Failed to send error reply to slack about reply processing failure for context ${contextIdentifier}`,
            slackError
          );
        }
        // Ensure a response is sent even on error
        res.status(500).json({
          success: false,
          error: `Failed to process reply: ${error.message}`,
        });
        return; // Exit after sending error response
      }
      // If we reached here in the reply path, processing was successful (either re-asked or created page)
      res.status(200).json({ message: "Reply processed." });
      return; // Handled as part of an ongoing interaction
    }

    // --- If not a reply to a tracked interaction (interactionState is null) ---
    logger.info(
      `[MCP CLIENT LOG] Context ${contextIdentifier} not found in pending interactions. Processing as new.`
    );

    try {
      // ... Step 1: Structure incoming Slack message ...
      const structuredSlackMessage =
        await tools_slack.receiveSlackIssueMessage_tool({
          /* ... */
        });
      logger.info(
        "[MCP CLIENT LOG] Step 1: Structured Slack Message:",
        structuredSlackMessage
      );

      // ... Step 2: Parse issue info ...
      const parsedIssueInfoRaw =
        await tools_processing.parseIssueFromSlackText_tool({
          /* ... */
        });
      logger.info(
        "[MCP CLIENT LOG] Step 2: Initial Parsed Issue Info (Raw):",
        parsedIssueInfoRaw
      );

      // --- Gap Analysis ---
      let missingInfo = [];
      // ... (same logic as before to populate missingInfo) ...

      if (missingInfo.length > 0) {
        // Information is missing, store state IN DYNAMODB and ask user
        logger.info(
          "[MCP CLIENT LOG] Missing information identified, asking user:",
          missingInfo.map((p) => ({
            field: p.displayName,
            question: p.question,
          }))
        );

        if (docClient) {
          // Only store if DB client is available
          const newState = {
            initialParsedInfoRaw: parsedIssueInfoRaw,
            structuredSlackMessage: structuredSlackMessage,
            missingInfo: missingInfo,
            createdAt: Date.now(),
          };
          const ttlTimestamp = Math.floor(
            (newState.createdAt + PENDING_INTERACTION_TIMEOUT_MS) / 1000
          );
          const putCommand = new PutCommand({
            TableName: DYNAMODB_STATE_TABLE,
            Item: {
              contextIdentifier, // Primary Key
              ...newState,
              ttl: ttlTimestamp, // TTL attribute
            },
          });
          await docClient.send(putCommand);
          logger.info(
            `[State Store] Stored initial pending interaction in DynamoDB for context: ${contextIdentifier} with TTL ${ttlTimestamp}`
          );

          const blocks = buildMissingInfoBlocks(
            missingInfo,
            parsedIssueInfoRaw
          );
          await tools_slack.postSlackReply_tool({
            channelId: structuredSlackMessage.channelId,
            messageText:
              "Thanks for reporting this! To log it accurately in Notion, could you please clarify a few things?",
            blocks: blocks,
            threadTimestamp: contextIdentifier, // Reply in the context thread
          });
          logger.info(
            `[MCP CLIENT LOG] Asked clarifying questions in context ${contextIdentifier}. Waiting for reply/interaction.`
          );
          res.status(200).json({ message: "Asking user for clarification." });
        } else {
          logger.error(
            "[MCP CLIENT ERROR] Cannot store state because DynamoDB client is not available."
          );
          res.status(500).json({
            success: false,
            error:
              "State management is disabled, cannot ask for clarification.",
          });
        }
        return;
      }

      // ... If no missing info, proceed directly to Notion ...
      logger.info(
        "[MCP CLIENT LOG] No missing information identified, proceeding to Notion creation."
      );
      const notionResult = await processAndCreateNotionPage(
        parsedIssueInfoRaw,
        structuredSlackMessage,
        null, // No state object to pass as it wasn't stored
        null // No contextIdentifier needed for cleanup as nothing was stored
      );
      res.status(200).json({
        message: "Issue created successfully.",
        notionUrl: notionResult?.url,
      });
    } catch (error) {
      logger.error(
        "[MCP CLIENT ERROR] Orchestration failed:",
        error,
        error.stack
      ); // Log stack trace
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  } else if (slackEventPayload.type === "url_verification") {
    // ... url verification ...
  } else {
    // ... other event types ...
    if (!res.headersSent) {
      res.status(200).send("Event type not handled by this application.");
    }
  }
});

// Endpoint for Slack Interactive Components (e.g., button clicks)
app.post(
  "/webhook/slack/interactive",
  urlencodedParserForInteractive,
  async (req, res) => {
    const slackInteractivePayload = JSON.parse(req.body.payload);
    // ... (optional signature verification) ...

    // Acknowledge Slack immediately.
    res.status(200).send();

    const contextIdentifier =
      slackInteractivePayload.container?.thread_ts ||
      slackInteractivePayload.message?.ts ||
      slackInteractivePayload.message?.thread_ts;
    const userId = slackInteractivePayload.user.id;

    if (!contextIdentifier) {
      logger.error(
        "[MCP CLIENT LOG - Interactive] Could not determine contextIdentifier from interactive payload."
      );
      return;
    }

    logger.info(
      `[MCP CLIENT LOG - Interactive] Processing interactive event for context: ${contextIdentifier} by user ${userId}`
    );

    // --- Retrieve state from DynamoDB ---
    let interactionState = null;
    if (docClient) {
      try {
        const getCommand = new GetCommand({
          TableName: DYNAMODB_STATE_TABLE,
          Key: { contextIdentifier },
        });
        const { Item } = await docClient.send(getCommand);
        if (Item) {
          const nowInSeconds = Math.floor(Date.now() / 1000);
          if (Item.ttl && Item.ttl < nowInSeconds) {
            logger.warn(
              `[State Store - Interactive] Found expired state for context ${contextIdentifier} in DynamoDB (TTL expired). Ignoring interaction.`
            );
            // Optionally delete it immediately
            const deleteCommand = new DeleteCommand({
              TableName: DYNAMODB_STATE_TABLE,
              Key: { contextIdentifier },
            });
            await docClient.send(deleteCommand);
          } else {
            interactionState = Item;
            logger.info(
              `[State Store - Interactive] Retrieved active state for context ${contextIdentifier} from DynamoDB.`
            );
          }
        } else {
          logger.info(
            `[State Store - Interactive] No active state found for context ${contextIdentifier} in DynamoDB.`
          );
        }
      } catch (error) {
        logger.error(
          `[State Store ERROR - Interactive] Failed to get state for ${contextIdentifier} from DynamoDB:`,
          error
        );
        // Maybe send ephemeral message back to user? Difficult without response_url sometimes.
        return; // Exit if state retrieval fails
      }
    } else {
      logger.warn(
        "[State Store - Interactive] DynamoDB client not available. Cannot process interaction requiring state."
      );
      return; // Exit if state management is disabled
    }

    // if (pendingInteractions[contextIdentifier]) { // REMOVED check against in-memory
    if (interactionState) {
      // Use retrieved state
      // const interactionState = pendingInteractions[contextIdentifier]; // REMOVED
      let issueData = interactionState.initialParsedInfoRaw;
      let interactionUpdated = false;

      // ... (logic to process actions and update issueData, set interactionUpdated = true) ...
      if (
        slackInteractivePayload.actions &&
        slackInteractivePayload.actions.length > 0
      ) {
        const action = slackInteractivePayload.actions[0];
        logger.info(
          `[MCP CLIENT LOG - Interactive] Action ID: ${action.action_id}, Selected Value: ${action.selected_option?.value}`
        );

        if (action.action_id === "select_priority" && action.selected_option) {
          issueData.Priority = action.selected_option.value;
          interactionUpdated = true;
          logger.info(
            `[MCP CLIENT LOG - Interactive] Updated Priority to: ${issueData.Priority} for context ${contextIdentifier}`
          );
        } else if (
          action.action_id === "select_issue_type" &&
          action.selected_option
        ) {
          issueData.IssueType = action.selected_option.value;
          interactionUpdated = true;
          logger.info(
            `[MCP CLIENT LOG - Interactive] Updated IssueType to: ${issueData.IssueType} for context ${contextIdentifier}`
          );
        }
        // Add more else if blocks here for other action_ids as needed
      }

      if (interactionUpdated) {
        interactionState.initialParsedInfoRaw = issueData; // Update the local copy

        // Re-evaluate what's missing
        let stillMissingInfo = [];
        // ... (same logic as before to populate stillMissingInfo) ...
        for (const profileName in NOTION_PROPERTY_PROFILES) {
          const profile = NOTION_PROPERTY_PROFILES[profileName];
          const value =
            interactionState.initialParsedInfoRaw[profile.parsedKey];
          if (!profile.isAdequate(value)) {
            stillMissingInfo.push(profile);
          }
        }
        interactionState.missingInfo = stillMissingInfo; // Update local copy

        if (interactionState.missingInfo.length > 0) {
          logger.info(
            `[MCP CLIENT LOG - Interactive] Context ${contextIdentifier}: Still missing info after interactive update, asking again.`,
            interactionState.missingInfo.map((p) => ({
              field: p.displayName,
              question: p.question,
            }))
          );

          // Update state in DynamoDB with refreshed TTL
          interactionState.createdAt = Date.now(); // Update timestamp for TTL
          const ttlTimestamp = Math.floor(
            (interactionState.createdAt + PENDING_INTERACTION_TIMEOUT_MS) / 1000
          );
          const putCommand = new PutCommand({
            TableName: DYNAMODB_STATE_TABLE,
            Item: {
              ...interactionState, // Store the whole updated state
              contextIdentifier, // Ensure key is present
              ttl: ttlTimestamp, // Add TTL
            },
          });
          await docClient.send(putCommand);
          logger.info(
            `[State Store - Interactive] Updated state in DynamoDB for context ${contextIdentifier} with TTL ${ttlTimestamp}.`
          );

          const blocks = buildMissingInfoBlocks(
            interactionState.missingInfo,
            interactionState.initialParsedInfoRaw
          );
          // Post a new message
          await tools_slack.postSlackReply_tool({
            channelId: slackInteractivePayload.channel.id,
            messageText: "Thanks! Almost there. Still need a bit more info:",
            blocks: blocks,
            threadTimestamp: contextIdentifier,
          });
          logger.info(
            `[MCP CLIENT LOG - Interactive] Re-asked for info in context ${contextIdentifier}.`
          );
        } else {
          // All info gathered, proceed to Notion AND delete state from DynamoDB
          logger.info(
            `[MCP CLIENT LOG - Interactive] All info gathered for context ${contextIdentifier} via interactive action. Proceeding to Notion.`
          );
          await processAndCreateNotionPage(
            interactionState.initialParsedInfoRaw,
            interactionState.structuredSlackMessage,
            null, // No need to pass full state object anymore?
            contextIdentifier // Pass context ID for deletion
          );
          // Cleanup handled within processAndCreateNotionPage
        }
      } else {
        logger.warn(
          `[MCP CLIENT LOG - Interactive] No relevant action found in payload for context ${contextIdentifier} or action did not update data. Action ID: ${slackInteractivePayload.actions[0]?.action_id}`
        );
      }
    } else {
      // Case where interactionState was null (not found or expired in DB)
      logger.warn(
        `[MCP CLIENT LOG - Interactive] No active pending interaction found for context ${contextIdentifier}. This interaction might have timed out or the context ID is incorrect.`
      );
      // Optionally, send an ephemeral message to the user via response_url if the interaction is stale
      // (Requires using slackInteractivePayload.response_url)
    }
  }
);

app.get("/", (req, res) => {
  res.send(
    `MCP Slack-Notion Demo App is running! Current LOG_LEVEL: ${LOG_LEVEL}. Notion DB ID: ${NOTION_DATABASE_ID}. POST to /webhook/slack/event to simulate a Slack message.`
  );
});

// --- Add Lambda Handler ---
// Create a server instance for aws-serverless-express
const server = awsServerlessExpress.createServer(app);

// Export the handler function for Lambda
exports.handler = (event, context) => {
  // Keep the Lambda container alive until the Node.js event loop is empty *after* the HTTP
  // request/response is fully processed. This lets our awaited promises (OpenAI, Slack, Notion)
  // finish even after Express has sent its response back via API Gateway.
  context.callbackWaitsForEmptyEventLoop = true;

  logger.info(`[EVENT] Received event: ${JSON.stringify(event)}`);

  // Use the PROMISE interface so we can return it, ensuring Lambda waits for the
  // proxy server's lifecycle to complete instead of calling context.succeed early.
  return awsServerlessExpress.proxy(server, event, context, "PROMISE").promise;
};

// Helper function to normalize Slack permalinks by removing query parameters
const canonicalizeSlackPermalink = (permalink) => {
  if (typeof permalink !== "string") {
    return permalink; // Or handle error appropriately
  }
  return permalink.split("?")[0];
};

// Helper function to build Block Kit blocks for missing info
function buildMissingInfoBlocks(missingInfo, currentParsedInfo) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Thanks for reporting this! To log it accurately in Notion, could you please clarify a few things?",
      },
    },
  ];

  missingInfo.forEach((profile) => {
    if (profile.parsedKey === "Priority") {
      blocks.push({
        type: "section",
        block_id: `ask_${profile.parsedKey}_section`,
        text: {
          type: "mrkdwn",
          text: `*${profile.displayName}:* ${profile.question}`,
        },
        accessory: {
          type: "static_select",
          action_id: "select_priority",
          placeholder: { type: "plain_text", text: "Select priority..." },
          initial_option:
            currentParsedInfo.Priority &&
            !currentParsedInfo.Priority.startsWith("UNKNOWN_")
              ? {
                  text: {
                    type: "plain_text",
                    text: currentParsedInfo.Priority,
                  },
                  value: currentParsedInfo.Priority,
                }
              : undefined,
          options: [
            { text: { type: "plain_text", text: "High" }, value: "High" },
            { text: { type: "plain_text", text: "Medium" }, value: "Medium" },
            { text: { type: "plain_text", text: "Low" }, value: "Low" },
          ],
        },
      });
    } else if (profile.parsedKey === "IssueType") {
      blocks.push({
        type: "section",
        block_id: `ask_${profile.parsedKey}_section`,
        text: {
          type: "mrkdwn",
          text: `*${profile.displayName}:* ${profile.question}`,
        },
        accessory: {
          type: "static_select",
          action_id: "select_issue_type",
          placeholder: { type: "plain_text", text: "Select type..." },
          initial_option:
            currentParsedInfo.IssueType &&
            !currentParsedInfo.IssueType.startsWith("UNKNOWN_")
              ? {
                  text: {
                    type: "plain_text",
                    text: currentParsedInfo.IssueType,
                  },
                  value: currentParsedInfo.IssueType,
                }
              : undefined,
          options: [
            { text: { type: "plain_text", text: "Bug" }, value: "Bug" },
            { text: { type: "plain_text", text: "Task" }, value: "Task" },
            {
              text: { type: "plain_text", text: "Incident" },
              value: "Incident",
            },
            { text: { type: "plain_text", text: "Test" }, value: "Test" },
          ],
        },
      });
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${profile.displayName}:* ${profile.question}\n(Please reply in this thread for this item)`,
        },
      });
    }
  });

  // Add a general instruction if there are any button-based questions
  const hasButtonQuestions = missingInfo.some(
    (p) => p.parsedKey === "Priority" || p.parsedKey === "IssueType"
  );
  if (hasButtonQuestions) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Please use the buttons above for Priority/Type and reply in this thread for any other requested details.",
        },
      ],
    });
  }
  return blocks;
}

// --- Helper function to create Notion Page AND cleanup state ---
// Modified to accept contextIdentifier for cleanup
async function processAndCreateNotionPage(
  parsedInfo,
  slackMsg,
  interactionState /* unused? */,
  contextIdentifier
) {
  // ... (existing logic to determine triage, map properties) ...

  // Assume triageResult = { targetDatabaseId, issueType, priority }
  const triageResult = await tools_processing.determineTriageCategory_tool({
    structuredIssueData: parsedInfo,
  });

  // Map parsedInfo and triageResult to Notion API property structure
  const pageProperties = mapToNotionProperties(
    parsedInfo,
    slackMsg.permalink,
    triageResult.issueType,
    triageResult.priority
  );
  logger.info("[MCP CLIENT LOG] Mapped Notion Properties:", pageProperties);

  // Step 4: Check if Notion page already exists for this Slack message permalink
  // Canonicalize permalink before searching
  const canonicalPermalink = canonicalizeSlackPermalink(slackMsg.permalink);
  const existingPage = await tools_notion.findNotionPageBySlackLink_tool({
    slackMessagePermalink: canonicalPermalink,
  });

  let notionResult;
  let finalMessage;

  if (existingPage && existingPage.pageId) {
    // Step 5a: Update existing page (if desired - current logic doesn't update)
    logger.warn(
      `[MCP CLIENT LOG] Notion page ${existingPage.pageId} already exists for Slack message ${canonicalPermalink}. Skipping creation/update.`
    );
    // Optionally implement update logic here using tools_notion.updateNotionPage_tool
    notionResult = existingPage; // Use existing page info
    finalMessage = `:information_source: An issue for this message already exists: ${notionResult.url}`;
  } else {
    // Step 5b: Create new Notion page
    logger.info("[MCP CLIENT LOG] Creating new Notion page...");
    notionResult = await tools_notion.createNotionPage_tool({
      targetDatabaseId: triageResult.targetDatabaseId,
      pageProperties: pageProperties,
    });
    logger.info("[MCP CLIENT LOG] Notion Page Creation Result:", notionResult);
    finalMessage = `:white_check_mark: Issue logged successfully: ${notionResult.url}`;
  }

  // Step 6: Post confirmation back to Slack thread
  await tools_slack.postSlackReply_tool({
    channelId: slackMsg.channelId,
    messageText: finalMessage,
    threadTimestamp: contextIdentifier || slackMsg.timestamp, // Use context ID if available, else original ts
  });

  // Step 7: Cleanup state from DynamoDB if it was part of an interaction
  if (contextIdentifier && docClient) {
    try {
      logger.info(
        `[State Cleanup] Attempting to delete state for context ${contextIdentifier} from DynamoDB after Notion processing.`
      );
      const deleteCommand = new DeleteCommand({
        TableName: DYNAMODB_STATE_TABLE,
        Key: { contextIdentifier },
      });
      await docClient.send(deleteCommand);
      logger.info(
        `[State Cleanup] Successfully deleted state for context ${contextIdentifier} from DynamoDB.`
      );
    } catch (error) {
      logger.error(
        `[State Cleanup ERROR] Failed to delete state for ${contextIdentifier} from DynamoDB:`,
        error
      );
      // Log error but continue, as main task (Notion) is done.
    }
    // delete pendingInteractions[contextIdentifier]; // REMOVED
  }

  return notionResult; // Return the result for potential use in the HTTP response
}

// --- Helper: Map to Notion Properties ---
// (Ensure this function exists and correctly maps your parsedInfo fields)
function mapToNotionProperties(parsedInfo, permalink, issueType, priority) {
  // IMPORTANT: Adjust property names ('Title', 'Status', etc.) and types
  // (title, select, url, rich_text) to EXACTLY match your Notion database schema.
  const properties = {
    Title: {
      // Assuming 'Title' is the name of your Title property
      title: [{ text: { content: parsedInfo.Title || "Untitled Issue" } }],
    },
    Status: {
      // Assuming 'Status' is a Select property
      select: { name: "New" }, // Default status
    },
    "Link to Slack Message": {
      // Assuming this is a URL property
      url: canonicalizeSlackPermalink(permalink), // Use canonicalized link
    },
    Priority: {
      // Assuming 'Priority' is a Select property
      select: { name: priority }, // Use determined priority
    },
    Type: {
      // Assuming 'Type' is a Select property
      select: { name: issueType }, // Use determined type
    },
    // Add mappings for other fields like Description, RootCause, SuccessCriteria, Resolution
    Description: {
      rich_text: [
        {
          text: {
            content: parsedInfo.Description || parsedInfo.originalText || "N/A",
          },
        },
      ],
    },
    "Root Cause": {
      rich_text: [
        {
          text: {
            content:
              parsedInfo.RootCause !== "UNKNOWN_ROOT_CAUSE"
                ? parsedInfo.RootCause
                : "N/A",
          },
        },
      ],
    },
    "Success Criteria": {
      rich_text: [
        {
          text: {
            content:
              parsedInfo.SuccessCriteria !== "UNKNOWN_SUCCESS_CRITERIA"
                ? parsedInfo.SuccessCriteria
                : "N/A",
          },
        },
      ],
    },
    Resolution: {
      rich_text: [
        {
          text: {
            content:
              parsedInfo.Resolution !== "UNKNOWN_RESOLUTION"
                ? parsedInfo.Resolution
                : "N/A",
          },
        },
      ],
    },
    // Add others as needed based on your NOTION_PROPERTY_PROFILES and DB schema
  };
  // Clean up properties with null/undefined selects before sending
  Object.keys(properties).forEach((key) => {
    if (properties[key].select && !properties[key].select.name) {
      delete properties[key];
    }
  });
  return properties;
}

// --- Helper: Canonicalize Slack Permalink ---
// ... existing canonicalizeSlackPermalink ...
