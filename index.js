const express = require("express");
const bodyParser = require("body-parser");
const { Client } = require("@notionhq/client"); // Import Notion Client
const OpenAI = require("openai"); // Import OpenAI Client
const { WebClient } = require("@slack/web-api"); // Import Slack WebClient
const crypto = require("crypto"); // Needed for signature verification
const {
  getPendingInteraction,
  putPendingInteraction,
  updatePendingInteraction,
  deletePendingInteraction,
  markInteractionCompleted,
  isInteractionCompleted,
} = require("./dynamodb");
const querystring = require("querystring");

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
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  logger.info("OpenAI client initialized.");
} else {
  logger.warn("OPENAI_API_KEY is not set. OpenAI features will be disabled.");
}

// Slack Web Client Initialization
let slackWebClient;
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
const PENDING_INTERACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
// Cleanup old pending interactions periodically
// setInterval(() => { ... }, 60 * 1000); // REMOVE THIS

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

    if (slackWebClient) {
      try {
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
          logger.warn(
            "[MCP TOOL LOG: Slack] Failed to get permalink from Slack API, using fallback.",
            result.error || "Unknown error"
          );
        }
      } catch (error) {
        logger.error(
          "[MCP TOOL ERROR: Slack] Error fetching permalink:",
          error
        );
        // Keep fallback permalink on error
      }
    } else {
      logger.warn(
        "[MCP TOOL LOG: Slack] Slack WebClient not initialized. Using fallback permalink."
      );
    }

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
      const prompt = `You are an expert issue triage assistant. Your task is to analyze a Slack message and extract structured information for creating an issue in a Notion tracker. Output a valid JSON object with the following keys, using EXACTLY the spelling and casing provided below (no spaces, underscores, or alternate casing):

Title: (String) A concise summary of the main problem or request, typically 5-15 words. If a clear title cannot be derived, use "UNKNOWN_TITLE". Sentence case.
Description: (String) The full, verbatim text of the original Slack message. This will be used as the primary description content.
RootCause: (String) If the message explicitly mentions a root cause, extract it. If the user states the root cause is unknown, unclear, or similar, use "Unclear". If not mentioned at all, use "UNKNOWN_ROOT_CAUSE". If the user explicitly states "N/A", use "N/A".
IssueType: (String) Categorize into one of: "Bug", "Incident", "Task", "Test". If not clearly inferable from the message content, use "UNKNOWN_ISSUE_TYPE".
Priority: (String) Categorize into one of: "High", "Medium", "Low". If not clearly inferable, use "UNKNOWN_PRIORITY".
SuccessCriteria: (String) If the message specifies success criteria or definition of done, extract it. If not mentioned, use "UNKNOWN_SUCCESS_CRITERIA". If the user explicitly states "N/A", use "N/A".
Resolution: (String) If the message specifies a resolution or fix, extract it. If not mentioned, use "UNKNOWN_RESOLUTION". If the user explicitly states "N/A", use "N/A".
PictureURL: (String) If there is a picture or image attached, provide the URL. Otherwise, use "No picture attached".
MentionedImageURL: (String) If the user pastes a URL to an image directly in the message text, extract that URL. Otherwise, use "NO_MENTIONED_IMAGE_URL". (Note: Actual attached files are handled separately by the system).
originalText: (String) The original Slack message text.

IMPORTANT:
- Use ONLY the above keys in your output JSON. Do NOT use spaces, underscores, or alternate casing in keys. For example, do NOT use "Root Cause", "root_cause", or "rootcause"—use ONLY "RootCause". The same applies for all other keys.
- Do NOT invent information. If information is not available, use the appropriate "UNKNOWN_*" value, "N/A", or "Unclear" as specified.
- ALWAYS include ALL keys above in your output, even if the value is "UNKNOWN_*", "N/A", or similar.
- NEVER return extra keys or omit any of the above keys.
- ALWAYS return a valid JSON object, not markdown or text. Do NOT use triple backticks or any markdown formatting.
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
     "PictureURL": "No picture attached",
     "MentionedImageURL": "NO_MENTIONED_IMAGE_URL",
     "originalText": "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module"
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
     "PictureURL": "No picture attached",
     "MentionedImageURL": "http://example.com/login_error.png",
     "originalText": "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment. See screenshot at http://example.com/login_error.png"
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
      "PictureURL": "No picture attached",
      "MentionedImageURL": "NO_MENTIONED_IMAGE_URL",
      "originalText": "The pump is making a weird noise again. We fixed it by restarting the controller. Not sure what criteria for success would be, N/A for now. Root cause is totally unknown."
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
        "PictureURL": "No picture attached",
        "MentionedImageURL": "NO_MENTIONED_IMAGE_URL",
        "originalText": "Need to order more coffee."
   }

Slack Message to parse:
${rawSlackText}

JSON Output:
`;

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4.1-2025-04-14", // Or your preferred model
          messages: [{ role: "user", content: prompt }],
        });
        logger.tool(
          "Processing",
          "Parsed data from OpenAI:",
          response.choices[0].message.content
        );
        return normalizeParsedInfo(
          JSON.parse(response.choices[0].message.content)
        );
      } catch (error) {
        logger.error(
          "[MCP TOOL ERROR: OpenAI] Failed to parse Slack message:",
          error.body || error.message
        );
        logger.warn("Falling back to basic parsing due to OpenAI error.");
        return normalizeParsedInfo(structuredDataFallback); // Fallback on error
      }
    } else {
      logger.warn(
        "OpenAI client not initialized. Using mock/fallback parseIssueFromSlackText_tool."
      );
      return normalizeParsedInfo(structuredDataFallback);
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
      return normalizeParsedInfo(originalParsedInfo); // Cannot proceed without LLM
    }

    const questionList = questionsAsked
      .map((q) => `- ${q.displayName} (${q.parsedKey}): ${q.question}`)
      .join("\n");
    const originalJson = JSON.stringify(originalParsedInfo, null, 2);

    const prompt = `You are an AI assistant tasked with updating a JSON object containing issue details. You will be given the original JSON object, a list of specific fields the user was asked to clarify, and the user's reply.

Your goal is to update the JSON object based *only* on the information the user provided in their reply *for the fields they were asked about*.

Here is the original JSON data:
${originalJson}

The user was asked to provide information for the following fields (internal JSON key name is in parentheses):
${questionList} 
// Example format for questionList items: "- Success Criteria (SuccessCriteria): What are the success criteria...?"

The user's reply is: "${userReplyText}"

Instructions for updating the JSON:
1.  For each field the user was asked about:
    a.  If the user's reply provides a clear and direct answer for that specific field, update the value of the corresponding key in the JSON object.
    b.  If the user's reply does *not* provide a clear answer for that specific asked field, or if they indicate they don't know or it's N/A (and the original value wasn't already "N/A" or similar), retain the original value for that key from the provided JSON (it might be an "UNKNOWN_*" placeholder, an existing value, or "N/A").
2.  For any fields in the original JSON object that the user was *not* asked about in this round, their values MUST remain unchanged. Do not infer or update these fields.
3.  Ensure the entire, updated JSON object is returned.

Output ONLY the complete, updated, valid JSON object. Do not include any other text or explanations.
`;

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4.1-2025-04-14", // Or your preferred model
        messages: [{ role: "user", content: prompt }],
      });
      const updatedJsonString = response.choices[0].message.content;
      logger.tool(
        "Processing",
        "Updated parsed data from OpenAI:",
        updatedJsonString
      );
      // Basic validation: Try parsing and check if it's an object
      const extractedJsonString = extractJson(updatedJsonString);
      const updatedParsedInfo = normalizeParsedInfo(
        JSON.parse(extractedJsonString)
      );
      if (typeof updatedParsedInfo !== "object" || updatedParsedInfo === null) {
        throw new Error("LLM did not return a valid JSON object.");
      }
      return updatedParsedInfo;
    } catch (error) {
      logger.error(
        "[MCP TOOL ERROR: OpenAI] Failed to parse answers and update data:",
        error.body || error.message
      );
      logger.warn("Returning original data due to error parsing answers.");
      return normalizeParsedInfo(originalParsedInfo); // Return original on error
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

// --- Robust Key Normalization Utility ---
function normalizeKey(key) {
  // Lowercase, remove spaces, underscores, dashes, and apostrophes
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CANONICAL_KEYS = {
  title: "Title",
  description: "Description",
  rootcause: "RootCause",
  rootcauses: "RootCause",
  root_cause: "RootCause",
  "root cause": "RootCause",
  issuetype: "IssueType",
  issue_type: "IssueType",
  "issue type": "IssueType",
  priority: "Priority",
  successcriteria: "SuccessCriteria",
  success_criteria: "SuccessCriteria",
  "success criteria": "SuccessCriteria",
  resolution: "Resolution",
  pictureurl: "PictureURL",
  picture_url: "PictureURL",
  "picture url": "PictureURL",
  mentionedimageurl: "MentionedImageURL",
  mentioned_image_url: "MentionedImageURL",
  "mentioned image url": "MentionedImageURL",
  originaltext: "originalText",
  original_text: "originalText",
  "original text": "originalText",
};

function normalizeParsedInfo(parsed) {
  if (!parsed) return parsed;
  const normalized = {};
  for (const key in parsed) {
    const normKey = normalizeKey(key);
    const canonicalKey = CANONICAL_KEYS[normKey] || key;
    normalized[canonicalKey] = parsed[key];
  }
  return normalized;
}

// --- Flexible Adequacy Checks ---
const ADEQUATE_VALUES = {
  na: true,
  n_a: true,
  unclear: true,
  unknown: true,
  "n/a": true,
  "n.a.": true,
  "n.a": true,
  "not applicable": true,
};
function isAdequateValue(value, unknownPrefix) {
  if (!value || typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  if (v === "" || v.startsWith(unknownPrefix.toLowerCase())) return false;
  if (ADEQUATE_VALUES[v]) return true;
  return true;
}

// --- Update NOTION_PROPERTY_PROFILES to use robust isAdequate ---
// ... existing code ...
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
    isAdequate: (value) => isAdequateValue(value, "UNKNOWN_ISSUE_TYPE"),
    question: "What type of issue is this? (e.g., Bug, Task, Incident, Test)",
  },
  Priority: {
    parsedKey: "Priority",
    displayName: "Priority",
    isAdequate: (value) => isAdequateValue(value, "UNKNOWN_PRIORITY"),
    question: "What is the priority for this? (High, Medium, or Low)",
  },
  SuccessCriteria: {
    parsedKey: "SuccessCriteria",
    displayName: "Success Criteria",
    isAdequate: (value) => isAdequateValue(value, "UNKNOWN_SUCCESS_CRITERIA"),
    question:
      "What are the success criteria for resolving this? (If none, say 'N/A')",
  },
  RootCause: {
    parsedKey: "RootCause",
    displayName: "Root Cause",
    isAdequate: (value) => isAdequateValue(value, "UNKNOWN_ROOT_CAUSE"),
    question:
      "What is the suspected root cause? (If unknown, okay to say 'Unknown' or 'N/A')",
  },
};
// ... existing code ...

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

    // Acknowledge Slack immediately BEFORE any lengthy processing
    // Important: Only send response once. Subsequent logic should not try to res.send/json.
    res.status(200).json({ message: "Event received, processing..." });

    // --- Check if this message is part of an ongoing interaction context ---
    let interactionState;
    try {
      interactionState = await getPendingInteraction(contextIdentifier);
    } catch (err) {
      logger.error(`[DynamoDB] Error fetching pending interaction:`, err);
      interactionState = null;
    }
    if (interactionState) {
      logger.info(
        `[MCP CLIENT LOG] Received reply for tracked context: ${contextIdentifier}`
      );
      try {
        const userReplyText = messagePayload.text;
        logger.info(
          `[MCP CLIENT LOG] Processing reply: "${userReplyText}" for context ${contextIdentifier}`
        );
        const originalDataBeforeUpdate = interactionState.initialParsedInfoRaw;
        const updatedData = await tools_processing.parseAnswersAndUpdate_tool({
          userReplyText: userReplyText,
          originalParsedInfo: originalDataBeforeUpdate,
          questionsAsked: interactionState.missingInfo,
        });
        if (
          updatedData === originalDataBeforeUpdate &&
          userReplyText.trim() !== ""
        ) {
          logger.warn(
            `[MCP CLIENT LOG] parseAnswersAndUpdate_tool returned original data for context ${contextIdentifier}. User reply might not have been processed due to LLM error.`
          );
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText:
              ":warning: I had trouble processing your last reply. Could you please try rephrasing or ensure it directly answers the questions I asked?",
            threadTimestamp: contextIdentifier,
          });
          return;
        }
        interactionState.initialParsedInfoRaw = updatedData;
        logger.info(
          "[DEBUG] Updated parsed info after reply:",
          interactionState.initialParsedInfoRaw
        );
        logger.info(
          `[MCP CLIENT LOG] Step 2 Updated (Reply Path for context ${contextIdentifier}): Parsed Issue Info (Raw) after reply:`,
          interactionState.initialParsedInfoRaw
        );
        let stillMissingInfo = [];
        for (const profileName in NOTION_PROPERTY_PROFILES) {
          const profile = NOTION_PROPERTY_PROFILES[profileName];
          const value =
            interactionState.initialParsedInfoRaw[profile.parsedKey];
          logger.info(
            `[DEBUG] Checking field '${
              profile.parsedKey
            }': value='${value}' isAdequate=${profile.isAdequate(value)}`
          );
          if (!profile.isAdequate(value)) {
            stillMissingInfo.push(profile);
          }
        }
        logger.info(
          "[DEBUG] Missing info after reply:",
          stillMissingInfo.map((p) => p.parsedKey)
        );
        interactionState.missingInfo = stillMissingInfo;
        if (interactionState.missingInfo.length > 0) {
          logger.info(
            `[MCP CLIENT LOG] Context ${contextIdentifier}: Still missing info, asking again:`,
            interactionState.missingInfo.map((p) => ({
              field: p.displayName,
              question: p.question,
            }))
          );
          interactionState.createdAt = Date.now();
          try {
            await putPendingInteraction(
              contextIdentifier,
              interactionState,
              PENDING_INTERACTION_TIMEOUT_MS / 1000
            );
          } catch (err) {
            logger.error(`[DynamoDB] Error updating pending interaction:`, err);
          }
          const blocks = buildMissingInfoBlocks(
            interactionState.missingInfo,
            interactionState.initialParsedInfoRaw
          );
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText: "Thanks for the update! Still need a bit more info:",
            blocks: blocks,
            threadTimestamp: contextIdentifier,
          });
          logger.info(
            `[MCP CLIENT LOG] Re-asked for info in context ${contextIdentifier}.`
          );
        } else {
          logger.info(
            `[MCP CLIENT LOG] All info gathered for context ${contextIdentifier} via reply. Proceeding to Notion.`
          );
          await processAndCreateNotionPage(
            interactionState.initialParsedInfoRaw,
            interactionState.structuredSlackMessage,
            interactionState,
            contextIdentifier
          );
        }
      } catch (error) {
        logger.error(
          `[MCP CLIENT ERROR] Failed to process user reply for context ${contextIdentifier}:`,
          error
        );
        try {
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText: `:x: Sorry, I encountered an error trying to process your reply: ${error.message}`,
            threadTimestamp: contextIdentifier,
          });
        } catch (slackError) {
          logger.error(
            `Failed to send error reply to slack about reply processing failure for context ${contextIdentifier}`,
            slackError
          );
        }
      }
      return;
    }

    // --- If not a reply to a tracked interaction context, process as a new potential issue ---
    logger.info(
      `[MCP CLIENT LOG] Context ${contextIdentifier} not found in pending interactions. Processing as new.`
    );
    try {
      // Step 1: Structure incoming Slack message (get permalink, etc.)
      // Note: structuredSlackMessage.timestamp will be messagePayload.ts
      const structuredSlackMessage =
        await tools_slack.receiveSlackIssueMessage_tool({
          user: messagePayload.user,
          text: messagePayload.text,
          channel: messagePayload.channel,
          ts: messagePayload.ts, // Crucially, this is the specific message's ts
          attachments: messagePayload.files || [],
        });
      logger.info(
        "[MCP CLIENT LOG] Step 1: Structured Slack Message:",
        structuredSlackMessage
      );

      // Step 2: Attempt to parse all relevant info from the message text using LLM
      const parsedIssueInfoRaw =
        await tools_processing.parseIssueFromSlackText_tool({
          rawSlackText: structuredSlackMessage.text,
          attachments: structuredSlackMessage.attachments,
        });
      logger.info(
        "[MCP CLIENT LOG] Step 2: Initial Parsed Issue Info (Raw):",
        parsedIssueInfoRaw
      );

      // --- Gap Analysis: Check if we have all needed Notion properties ---
      let missingInfo = [];
      for (const profileName in NOTION_PROPERTY_PROFILES) {
        const profile = NOTION_PROPERTY_PROFILES[profileName];
        const value = parsedIssueInfoRaw[profile.parsedKey];
        if (!profile.isAdequate(value)) {
          missingInfo.push(profile);
        }
      }

      if (missingInfo.length > 0) {
        // Information is missing, store current state and ask user for clarification
        logger.info(
          "[MCP CLIENT LOG] Missing information identified, asking user:",
          missingInfo.map((p) => ({
            field: p.displayName,
            question: p.question,
          }))
        );

        const interactionState = {
          initialParsedInfoRaw: parsedIssueInfoRaw,
          structuredSlackMessage: structuredSlackMessage,
          missingInfo: missingInfo,
          createdAt: Date.now(),
        };
        try {
          await putPendingInteraction(
            contextIdentifier,
            interactionState,
            PENDING_INTERACTION_TIMEOUT_MS / 1000
          );
        } catch (err) {
          logger.error(`[DynamoDB] Error putting pending interaction:`, err);
        }
        logger.info(
          `[State Store] Stored pending interaction for context: ${contextIdentifier}`
        );
        const blocks = buildMissingInfoBlocks(missingInfo, parsedIssueInfoRaw);
        await tools_slack.postSlackReply_tool({
          channelId: structuredSlackMessage.channelId,
          messageText:
            "Thanks for reporting this! To log it accurately in Notion, could you please clarify a few things?",
          blocks: blocks,
          threadTimestamp: contextIdentifier,
        });
        logger.info(
          `[MCP CLIENT LOG] Asked clarifying questions in context ${contextIdentifier}. Waiting for reply/interaction.`
        );
        return;
      }

      // If no missing info, proceed directly to Notion creation
      logger.info(
        "[MCP CLIENT LOG] No missing information identified, proceeding to Notion creation."
      );
      // Pass null for interactionState and contextIdentifier as this is a direct creation
      await processAndCreateNotionPage(
        parsedIssueInfoRaw,
        structuredSlackMessage,
        null,
        null
      );
    } catch (error) {
      logger.error("[MCP CLIENT ERROR] Orchestration failed:", error);
      try {
        // Try to notify in the determined contextIdentifier
        await tools_slack.postSlackReply_tool({
          channelId: messagePayload.channel, // channel from original payload
          messageText: `:x: Error processing issue: ${error.message}`,
          threadTimestamp: contextIdentifier, // Post error in the context thread
        });
      } catch (slackError) {
        logger.error(
          `Failed to send error reply to slack for context ${contextIdentifier}`,
          slackError
        );
      }
    }
  } else if (slackEventPayload.challenge) {
    // This case is handled by the url_verification check at the top,
    // but good to have explicit else if for clarity if more event types were handled here.
    // logger.info("[MCP CLIENT LOG] Responding to Slack URL verification challenge.");
    // res.status(200).send(slackEventPayload.challenge);
  } else {
    logger.info(
      "[MCP CLIENT LOG] Received non-message or unhandled event type:",
      slackEventPayload.type
    );
    // res.status(200).send("Event type not handled by this demo."); // Potentially already sent 200
  }
});

// Helper function to build Block Kit blocks for missing info
// (This function was implicitly used before, now explicitly defined)
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
            {
              text: { type: "plain_text", text: "High" },
              value: "High",
            },
            {
              text: { type: "plain_text", text: "Medium" },
              value: "Medium",
            },
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
            // Add other valid issue types here
          ],
        },
      });
    } else {
      // For fields requiring text input
      blocks.push({
        type: "input",
        block_id: `ask_${profile.parsedKey}_input`,
        element: {
          type: "plain_text_input",
          action_id: `provide_${profile.parsedKey}`,
          placeholder: {
            type: "plain_text",
            text: `Your answer for ${profile.displayName}`,
          },
        },
        label: {
          type: "plain_text",
          text: `${profile.displayName}: ${profile.question}`,
        },
      });
      // The above input block is an example. The current app posts section blocks and asks for replies in thread.
      // To keep current behavior for text replies:
      blocks.pop(); // Remove the input block example
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

// --- Refactored Notion Creation Flow ---
// Encapsulates steps from normalization to final Slack reply
async function processAndCreateNotionPage(
  parsedInfoRaw,
  structuredSlackMessage,
  interactionState = null, // The full state object, if processing from a pending interaction
  interactionContextKey = null, // The key used for pendingInteractions (e.g., thread_ts or original message_ts)
  logger // Added logger parameter
) {
  // Use interactionContextKey if available (it's the true context of the conversation),
  // otherwise fallback to structuredSlackMessage.timestamp (ts of the specific message being processed directly)
  const primaryContextForLog =
    interactionContextKey || structuredSlackMessage.timestamp;

  const logPrefix = interactionState
    ? `[Interaction Flow Context ${primaryContextForLog}]`
    : `[Direct Flow Thread ${structuredSlackMessage.timestamp}]`; // Direct flow still tied to specific message ts
  logger.info(`${logPrefix} Starting Notion page creation/update process.`);

  try {
    // --- Normalize and default ---
    const normalizedPermalink = canonicalizeSlackPermalink(
      structuredSlackMessage.permalink
    );
    const issueTitle =
      parsedInfoRaw.Title !== "UNKNOWN_TITLE"
        ? parsedInfoRaw.Title || "Untitled Issue"
        : "Untitled Issue";
    const issueDescription =
      parsedInfoRaw.Description || parsedInfoRaw.originalText || "";
    const issueRootCause =
      parsedInfoRaw.RootCause !== "UNKNOWN_ROOT_CAUSE"
        ? parsedInfoRaw.RootCause || "N/A"
        : "N/A";
    const issuePictureUrl = parsedInfoRaw.PictureURL || "No picture attached";
    const issueType =
      parsedInfoRaw.IssueType !== "UNKNOWN_ISSUE_TYPE"
        ? parsedInfoRaw.IssueType || "Task"
        : "Task";
    const issuePriority =
      parsedInfoRaw.Priority !== "UNKNOWN_PRIORITY"
        ? parsedInfoRaw.Priority || "Medium"
        : "Medium";
    const issueSuccessCriteria =
      parsedInfoRaw.SuccessCriteria !== "UNKNOWN_SUCCESS_CRITERIA"
        ? parsedInfoRaw.SuccessCriteria || "N/A"
        : "N/A";
    const issueResolution =
      parsedInfoRaw.Resolution !== "UNKNOWN_RESOLUTION"
        ? parsedInfoRaw.Resolution || ""
        : "";

    const currentIssueDataForTriage = {
      Title: issueTitle,
      Description: issueDescription,
      "Root Cause": issueRootCause,
      "Issue Type": issueType,
      Priority: issuePriority,
      "Success Criteria": issueSuccessCriteria,
      "Picture URL": issuePictureUrl,
      Resolution: issueResolution,
      originalText: parsedInfoRaw.originalText,
    };

    logger.info(
      `${logPrefix} Step 2.5: Data for Triage:`,
      currentIssueDataForTriage
    );

    // --- Triage ---
    const triageDetails = await tools_processing.determineTriageCategory_tool({
      structuredIssueData: currentIssueDataForTriage,
    });
    logger.info(`${logPrefix} Step 3: Triage Details:`, triageDetails);

    // --- Check Existing ---
    const existingNotionPage =
      await tools_notion.findNotionPageBySlackLink_tool({
        slackMessagePermalink: normalizedPermalink,
      });
    logger.info(
      `${logPrefix} Step 4: Existing Notion Page Check:`,
      existingNotionPage
    );

    // --- Create/Update ---
    let notionPageDetails;
    if (existingNotionPage) {
      logger.info(
        `${logPrefix} Issue already logged: ${existingNotionPage.url}.`
      );
      notionPageDetails = existingNotionPage;
      // TODO: Update existing page logic could go here
    } else {
      let resolutionContentForNotion = issueResolution;
      const pageProperties = {
        Title: { title: [{ text: { content: issueTitle } }] },
        Type: { select: { name: issueType } },
        Priority: { multi_select: [{ name: issuePriority }] },
        Status: { status: { name: "Triage" } },
        "Success Criteria": {
          rich_text: [{ text: { content: issueSuccessCriteria } }],
        },
        "Resolution TL'DR": {
          rich_text: [{ text: { content: resolutionContentForNotion } }],
        },
        "Root Cause": { rich_text: [{ text: { content: issueRootCause } }] },
        "Link to Slack Message": { url: normalizedPermalink },
        "Date Identified": {
          date: {
            start: new Date(
              parseFloat(structuredSlackMessage.timestamp) * 1000
            ).toISOString(),
          },
        },
        Reporter: { people: [] },
        Assigned: { people: [] },
        Sprint: { relation: [] },
        Due: { date: null },
        "Program/Project": { relation: [] },
        "⏰ Versions": { relation: [] },
        Tags: { multi_select: [] },
        "Parent-task": { relation: [] },
        "Sub-tasks": { relation: [] },
        "Task ID": { rich_text: [{ text: { content: "N/A" } }] },
        "Mid-sprint task": { checkbox: false },
        "Est. Hours": { number: null },
      };
      // Add Files property if attachments exist
      if (
        structuredSlackMessage.attachments &&
        structuredSlackMessage.attachments.length > 0
      ) {
        pageProperties["Files"] = {
          files: structuredSlackMessage.attachments
            .map((file) => ({
              name: file.name || file.title || "Slack Attachment",
              type: "external",
              external: { url: file.permalink },
            }))
            .filter((f) => f.external.url),
        };
        if (pageProperties["Files"].files.length > 10) {
          logger.warn(
            `${logPrefix} [Notion Files] More than 10 attachments found, only linking the first 10.`
          );
          pageProperties["Files"].files = pageProperties["Files"].files.slice(
            0,
            10
          );
        }
        if (pageProperties["Files"].files.length === 0) {
          delete pageProperties["Files"];
        }
      }

      notionPageDetails = await tools_notion.createNotionPage_tool({
        targetDatabaseId: triageDetails.targetDatabaseId,
        pageProperties: pageProperties,
      });
      logger.info(
        `${logPrefix} Step 5: Notion Page Created/Details:`,
        notionPageDetails
      );
    }

    // --- Post Feedback ---
    if (notionPageDetails && notionPageDetails.url) {
      const replyMessage = existingNotionPage
        ? `:information_source: This issue was already logged here: <${notionPageDetails.url}|Open in Notion>`
        : `:white_check_mark: ${
            interactionState ? "All info received! Issue" : "Issue"
          } logged as *${
            triageDetails.issueType
          }* in Notion (Priority: ${issuePriority}): <${
            notionPageDetails.url
          }|Open in Notion>`;

      await tools_slack.postSlackReply_tool({
        channelId: structuredSlackMessage.channelId,
        messageText: replyMessage,
        threadTimestamp: structuredSlackMessage.timestamp, // Reply to original thread
      });
      logger.info(`${logPrefix} Step 6: Posted final feedback to Slack.`);
    }
    logger.info(`${logPrefix} --- Notion Workflow Complete ---`);
  } catch (error) {
    logger.error(`${logPrefix} Error during Notion workflow:`, error);
    // Attempt to notify user if possible
    try {
      await tools_slack.postSlackReply_tool({
        channelId: structuredSlackMessage.channelId,
        messageText: `:x: Sorry, I encountered an error while trying to log this to Notion: ${error.message}`,
        // Reply in the original interaction context if known, otherwise to the specific message's thread
        threadTimestamp:
          interactionContextKey || structuredSlackMessage.timestamp,
      });
    } catch (slackError) {
      logger.error(
        `${logPrefix} Failed to send Notion workflow error reply to Slack:`,
        slackError
      );
    }
  } finally {
    if (interactionState && interactionContextKey) {
      logger.info(
        `[State Cleanup] Removing completed/failed interaction for context: ${interactionContextKey}`
      );
      try {
        await deletePendingInteraction(interactionContextKey, logger); // Pass logger
        await markInteractionCompleted(interactionContextKey, logger); // Mark as completed
      } catch (err) {
        logger.error(
          `[DynamoDB] Error deleting or marking completed interaction:`,
          err
        );
      }
    } else if (interactionState) {
      const fallbackCleanupKey =
        structuredSlackMessage.thread_ts || structuredSlackMessage.timestamp;
      logger.warn(
        `[State Cleanup] Interaction state provided for cleanup, but interactionContextKey was missing. Using fallback key for cleanup: ${fallbackCleanupKey} (structuredSlackMessage.timestamp was ${structuredSlackMessage.timestamp})`
      );
      try {
        await deletePendingInteraction(fallbackCleanupKey, logger); // Pass logger and corrected variable name
        await markInteractionCompleted(fallbackCleanupKey, logger); // Mark as completed
      } catch (err) {
        logger.error(
          `[DynamoDB] Error deleting or marking completed interaction:`,
          err
        );
      }
    }
  }
}

// --- III. Slack Interactivity Handler ---

// Middleware function to verify Slack signature
const verifySlackSignature = (req, res, next) => {
  if (!SLACK_SIGNING_SECRET) {
    logger.warn(
      "[Security] SLACK_SIGNING_SECRET not set. Skipping interaction verification."
    );
    return next();
  }

  // rawBody should be set by the bodyParser.urlencoded with verify option
  if (!req.rawBody) {
    logger.error(
      "[Security] Raw body missing for signature verification. Ensure bodyParser.urlencoded with verify option ran first and successfully set req.rawBody for the interactive endpoint."
    );
    return res
      .status(500)
      .send("Internal Server Error: Raw body missing for verification");
  }

  const slackSignature = req.headers["x-slack-signature"];
  const timestamp = req.headers["x-slack-request-timestamp"];

  if (!slackSignature || !timestamp) {
    logger.warn(
      "[Security] Missing signature or timestamp headers for Slack interaction."
    );
    return res.status(400).send("Missing signature headers");
  }

  // Check timing
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) {
    logger.warn("[Security] Slack interaction timestamp expired.");
    return res.status(400).send("Timestamp expired");
  }

  // Verify signature
  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  const sig_basestring = "v0:" + timestamp + ":" + req.rawBody;

  try {
    hmac.update(sig_basestring);
    const computedSignature = "v0=" + hmac.digest("hex");

    if (
      !crypto.timingSafeEqual(
        Buffer.from(computedSignature, "utf8"),
        Buffer.from(slackSignature, "utf8")
      )
    ) {
      logger.warn("[Security] Slack interaction signature mismatch.");
      return res.status(400).send("Signature mismatch");
    }

    logger.info("[Security] Slack interaction signature verified.");
    next(); // Signature is valid
  } catch (e) {
    logger.error("[Security] Error during signature verification:", e);
    return res.status(500).send("Verification error");
  }
};

// Apply middleware specifically for the interaction route
app.post(
  "/webhook/slack/interactive",
  // 1. Use the new urlencoded parser that also captures rawBody
  urlencodedParserForInteractive,
  // 2. Verify the signature (uses req.rawBody set by the parser above)
  verifySlackSignature,
  // 3. Handle the verified and parsed request
  async (req, res) => {
    let payload;
    try {
      // Defensive checks and logging for debugging the "Missing payload" issue
      if (!req.body) {
        logger.error(
          "[Interaction] req.body is undefined or null after parsing attempts."
        );
        throw new Error("Request body object is missing.");
      }
      if (
        Object.keys(req.body).length === 0 &&
        req.rawBody &&
        req.rawBody.includes("payload=")
      ) {
        logger.warn(
          "[Interaction] req.body is an empty object, but rawBody contains 'payload='. This might indicate a parsing issue with urlencodedParser."
        );
      }
      if (!req.body.payload) {
        logger.error(
          `[Interaction] req.body.payload is missing or empty. Current req.body keys: '${Object.keys(
            req.body
          ).join(", ")}'. req.body dump: ${JSON.stringify(req.body)}`
        );
        if (req.rawBody) {
          logger.info(
            `[Interaction] For context, rawBody was (first 200 chars): ${req.rawBody.substring(
              0,
              200
            )}`
          );
        }
        throw new Error("Missing payload field in parsed request body.");
      }

      payload = JSON.parse(req.body.payload);
      logger.info(
        `[Interaction] Received payload type: ${payload.type}, action_id: ${
          payload.actions && payload.actions[0]
            ? payload.actions[0].action_id
            : "N/A"
        }`
      );
    } catch (e) {
      logger.error("[Interaction] Error parsing Slack payload:", e);
      return res.status(200).send(); // Acknowledge Slack even on parse error
    }

    // Acknowledge Slack immediately
    res.status(200).send();

    // Handle Block Actions (e.g., button clicks, select menu choices)
    if (
      payload.type === "block_actions" &&
      payload.actions &&
      payload.actions.length > 0
    ) {
      const action = payload.actions[0];
      const contextIdentifier =
        payload.container?.thread_ts || payload.message?.ts;

      if (!contextIdentifier) {
        logger.warn(
          "[Interaction] Block action without thread_ts in container or ts in message. Cannot identify context."
        );
        // Cannot reliably post a message back without context or channel/message identifiers.
        // response_url could be used if we had a generic HTTP tool, but we don't here.
        return;
      }

      let interactionState;
      try {
        interactionState = await getPendingInteraction(contextIdentifier);
      } catch (err) {
        logger.error(`[DynamoDB] Error fetching pending interaction:`, err);
        interactionState = null;
      }
      if (!interactionState) {
        logger.warn(
          `[Interaction] Interaction state not found or expired for context: ${contextIdentifier}. Action ID: ${action.action_id}`
        );
        // Try to inform the user in the original message's thread that the interaction has expired.
        if (payload.channel?.id && payload.message?.ts) {
          try {
            await tools_slack.postSlackReply_tool({
              channelId: payload.channel.id,
              messageText:
                ":warning: Sorry, this set of questions/buttons has expired. If you were in the middle of reporting an issue, please send your issue details again to start over.",
              threadTimestamp: payload.message.ts, // Reply to the message that had the buttons
            });
            logger.info(
              `[Interaction] Posted expiry message to thread ${payload.message.ts} in channel ${payload.channel.id}`
            );
          } catch (slackError) {
            logger.error(
              `[Interaction] Failed to send expiry message to Slack for context ${contextIdentifier}:`,
              slackError
            );
          }
        } else {
          logger.warn(
            `[Interaction] Cannot send expiry message for context ${contextIdentifier} due to missing channel_id or message_ts in payload.`
          );
        }
        return; // Stop processing this action
      }

      let fieldUpdated = false;
      const value = action.selected_option?.value || action.value; // Handles select menus and buttons
      logger.info(
        `[Interaction] Processing action '${action.action_id}' value '${value}' for context ${contextIdentifier}`
      );

      // --- Update State based on action ---
      if (action.action_id === "select_priority" && value) {
        interactionState.initialParsedInfoRaw.Priority = value;
        fieldUpdated = true;
      } else if (action.action_id === "select_issue_type" && value) {
        interactionState.initialParsedInfoRaw.IssueType = value;
        fieldUpdated = true;
      }
      // Add more else if blocks here for other interactive elements if any

      if (fieldUpdated) {
        logger.info(
          `[Interaction] Context ${contextIdentifier}: Updated interaction state from button/select:`,
          interactionState.initialParsedInfoRaw
        );
      } else {
        logger.warn(
          `[Interaction] Context ${contextIdentifier}: Unhandled action_id: ${action.action_id}`
        );
        return; // Don't proceed if action wasn't specifically handled
      }

      // --- Check Completion after button/select action ---
      // Remove the field just updated by button/select from the list of missingInfo
      // This assumes button/select actions directly satisfy a missing field.
      interactionState.missingInfo = interactionState.missingInfo.filter(
        (profile) =>
          !(
            profile.parsedKey === "Priority" &&
            action.action_id === "select_priority"
          ) &&
          !(
            profile.parsedKey === "IssueType" &&
            action.action_id === "select_issue_type"
          )
        // Add checks for other action_ids if they directly map to a missingInfo profile
      );

      interactionState.createdAt = Date.now(); // Touch the interaction
      try {
        await putPendingInteraction(
          contextIdentifier,
          interactionState,
          PENDING_INTERACTION_TIMEOUT_MS / 1000
        );
      } catch (err) {
        logger.error(`[DynamoDB] Error updating pending interaction:`, err);
      }

      // Check if any fields *requiring text replies* are still in missingInfo
      const needsTextReply = interactionState.missingInfo.some(
        (p) =>
          p.parsedKey === "SuccessCriteria" ||
          p.parsedKey === "RootCause" ||
          p.parsedKey === "Title" ||
          p.parsedKey === "Description"
        // Add other fields that are expected via text reply, not buttons
      );

      if (needsTextReply) {
        logger.info(
          `[Interaction] Context ${contextIdentifier} updated by button/select, but still waiting for text replies for other fields. Missing:`,
          interactionState.missingInfo.map((m) => m.displayName)
        );
        // Optionally, update the original message using response_url to reflect the choice and ask for remaining
        // For example, re-posting the updated list of questions.
        // For now, we assume the user will see their button click and continue replying in the thread for text.
        // The bot will re-ask on the next text message if info is still missing.
        return;
      }

      // If we get here, it means no *further text reply* is needed *after this button click*.
      // All button-updatable fields are filled, and no text-based fields remain in missingInfo.
      logger.info(
        `[Interaction] All information gathered for context ${contextIdentifier} via interactions/replies. Proceeding to Notion.`
      );

      // --- Trigger Notion Flow ---
      // Pass the final updated data, original message details, and the context key.
      await processAndCreateNotionPage(
        interactionState.initialParsedInfoRaw,
        interactionState.structuredSlackMessage,
        interactionState,
        contextIdentifier,
        logger // Pass logger
      );
    } else if (payload.type === "view_submission") {
      logger.info("[Interaction] Received view_submission (modal submitted).");
      // Implement modal submission logic here
    } else {
      logger.warn(
        "[Interaction] Received unhandled payload type or empty actions:",
        payload.type
      );
    }
  }
);

app.get("/", (req, res) => {
  res.send(
    `MCP Slack-Notion Demo App is running! Current LOG_LEVEL: ${LOG_LEVEL}. Notion DB ID: ${NOTION_DATABASE_ID}. POST to /webhook/slack/event to simulate a Slack message.`
  );
});

// Helper function to normalize Slack permalinks by removing query parameters
const canonicalizeSlackPermalink = (permalink) => {
  if (typeof permalink !== "string") {
    return permalink; // Or handle error appropriately
  }
  return permalink.split("?")[0];
};

// Helper: Parse JSON safely
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Helper: Parse urlencoded body
function parseUrlEncoded(body) {
  return querystring.parse(body);
}

// Helper: Lambda-style Slack signature verification
function verifySlackSignatureLambda(event, rawBody) {
  if (!SLACK_SIGNING_SECRET) {
    logger.warn(
      "[Security] SLACK_SIGNING_SECRET not set. Skipping verification."
    );
    return true; // Skip if not set
  }
  const slackSignature =
    event.headers["x-slack-signature"] || event.headers["X-Slack-Signature"];
  const timestamp =
    event.headers["x-slack-request-timestamp"] ||
    event.headers["X-Slack-Request-Timestamp"];
  if (!slackSignature || !timestamp) {
    logger.warn(
      "[Security] Missing signature or timestamp headers for Slack verification."
    );
    return false;
  }
  const fiveMinutesAgo = Date.now() / 1000 - 60 * 5;
  if (timestamp < fiveMinutesAgo) {
    logger.warn("[Security] Slack request timestamp expired.");
    return false;
  }
  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  const sig_basestring = "v0:" + timestamp + ":" + rawBody;
  hmac.update(sig_basestring);
  const computedSignature = "v0=" + hmac.digest("hex");
  try {
    const valid = crypto.timingSafeEqual(
      Buffer.from(computedSignature, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
  } catch {
    return false;
  }
}

// Lambda Handler: Slack Event Webhook
async function slackEventHandler(event, context) {
  let body = event.body;
  if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString();
  const payload = safeJsonParse(body);
  if (!payload || typeof payload !== "object") {
    return { statusCode: 400, body: "Invalid payload." };
  }
  // Slack URL Verification
  if (payload.type === "url_verification") {
    return { statusCode: 200, body: payload.challenge };
  }
  // Only handle event_callback with message
  if (
    payload.type === "event_callback" &&
    payload.event &&
    payload.event.type === "message"
  ) {
    // Ignore bot messages, edits, deletions
    if (
      payload.event.bot_id ||
      payload.event.subtype === "bot_message" ||
      payload.event.subtype === "message_changed" ||
      payload.event.subtype === "message_deleted"
    ) {
      return { statusCode: 200, body: "Ignoring event due to subtype." };
    }
    const messagePayload = payload.event;
    const contextIdentifier = String(
      messagePayload.thread_ts || messagePayload.ts
    ); // Ensure string
    // Check if this thread is already completed
    try {
      const completed = await isInteractionCompleted(contextIdentifier, logger);
      if (completed) {
        logger.info(
          `[MCP CLIENT LOG] Context ${contextIdentifier} already completed. Not starting new workflow.`
        );
        await tools_slack.postSlackReply_tool({
          channelId: messagePayload.channel,
          messageText:
            ":information_source: This issue has already been logged for this thread. If you have a new issue, please start a new thread.",
          threadTimestamp: contextIdentifier,
        });
        return { statusCode: 200, body: "Thread already completed." };
      }
    } catch (err) {
      logger.error(`[DynamoDB] Error checking completed marker:`, err);
      // Fail open: allow workflow to proceed if check fails
    }
    // --- Check if this message is part of an ongoing interaction context ---
    let interactionState;
    try {
      interactionState = await getPendingInteraction(contextIdentifier, logger); // Pass logger
    } catch (err) {
      logger.error(`[DynamoDB] Error fetching pending interaction:`, err);
      interactionState = null;
    }
    if (interactionState) {
      logger.info(
        `[MCP CLIENT LOG] Received reply for tracked context: ${contextIdentifier}`
      );
      try {
        const userReplyText = messagePayload.text;
        logger.info(
          `[MCP CLIENT LOG] Processing reply: "${userReplyText}" for context ${contextIdentifier}`
        );
        const originalDataBeforeUpdate = interactionState.initialParsedInfoRaw;
        const updatedData = await tools_processing.parseAnswersAndUpdate_tool({
          userReplyText: userReplyText,
          originalParsedInfo: originalDataBeforeUpdate,
          questionsAsked: interactionState.missingInfo,
        });
        if (
          updatedData === originalDataBeforeUpdate &&
          userReplyText.trim() !== ""
        ) {
          logger.warn(
            `[MCP CLIENT LOG] parseAnswersAndUpdate_tool returned original data for context ${contextIdentifier}. User reply might not have been processed due to LLM error.`
          );
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText:
              ":warning: I had trouble processing your last reply. Could you please try rephrasing or ensure it directly answers the questions I asked?",
            threadTimestamp: contextIdentifier,
          });
          return; // Return within Lambda: use object like { statusCode: 200, body: "..." }
        }
        interactionState.initialParsedInfoRaw = updatedData;
        logger.info(
          "[DEBUG] Updated parsed info after reply:",
          interactionState.initialParsedInfoRaw
        );
        logger.info(
          `[MCP CLIENT LOG] Step 2 Updated (Reply Path for context ${contextIdentifier}): Parsed Issue Info (Raw) after reply:`,
          interactionState.initialParsedInfoRaw
        );
        let stillMissingInfo = [];
        for (const profileName in NOTION_PROPERTY_PROFILES) {
          const profile = NOTION_PROPERTY_PROFILES[profileName];
          const value =
            interactionState.initialParsedInfoRaw[profile.parsedKey];
          logger.info(
            `[DEBUG] Checking field '${
              profile.parsedKey
            }': value='${value}' isAdequate=${profile.isAdequate(value)}`
          );
          if (!profile.isAdequate(value)) {
            stillMissingInfo.push(profile);
          }
        }
        logger.info(
          "[DEBUG] Missing info after reply:",
          stillMissingInfo.map((p) => p.parsedKey)
        );
        interactionState.missingInfo = stillMissingInfo;
        if (interactionState.missingInfo.length > 0) {
          logger.info(
            `[MCP CLIENT LOG] Context ${contextIdentifier}: Still missing info, asking again:`,
            interactionState.missingInfo.map((p) => ({
              field: p.displayName,
              question: p.question,
            }))
          );
          interactionState.createdAt = Date.now();
          try {
            await putPendingInteraction(
              contextIdentifier,
              interactionState,
              PENDING_INTERACTION_TIMEOUT_MS / 1000,
              logger // Pass logger
            );
          } catch (err) {
            logger.error(`[DynamoDB] Error updating pending interaction:`, err);
          }
          const blocks = buildMissingInfoBlocks(
            interactionState.missingInfo,
            interactionState.initialParsedInfoRaw
          );
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText: "Thanks for the update! Still need a bit more info:",
            blocks: blocks,
            threadTimestamp: contextIdentifier,
          });
          logger.info(
            `[MCP CLIENT LOG] Re-asked for info in context ${contextIdentifier}.`
          );
        } else {
          logger.info(
            `[MCP CLIENT LOG] All info gathered for context ${contextIdentifier} via reply. Proceeding to Notion.`
          );
          await processAndCreateNotionPage(
            interactionState.initialParsedInfoRaw,
            interactionState.structuredSlackMessage,
            interactionState,
            contextIdentifier,
            logger // Pass logger
          );
        }
      } catch (error) {
        logger.error(
          `[MCP CLIENT ERROR] Failed to process user reply for context ${contextIdentifier}:`,
          error
        );
        try {
          await tools_slack.postSlackReply_tool({
            channelId: messagePayload.channel,
            messageText: `:x: Sorry, I encountered an error trying to process your reply: ${error.message}`,
            threadTimestamp: contextIdentifier,
          });
        } catch (slackError) {
          logger.error(
            `Failed to send error reply to slack about reply processing failure for context ${contextIdentifier}`,
            slackError
          );
        }
      }
      return { statusCode: 200, body: "Handled reply in thread." };
    }
    // --- If not a reply, process as new ---
    try {
      const structuredSlackMessage =
        await tools_slack.receiveSlackIssueMessage_tool({
          user: messagePayload.user,
          text: messagePayload.text,
          channel: messagePayload.channel,
          ts: messagePayload.ts,
          attachments: messagePayload.files || [],
        });
      const parsedIssueInfoRaw =
        await tools_processing.parseIssueFromSlackText_tool({
          rawSlackText: structuredSlackMessage.text,
          attachments: structuredSlackMessage.attachments,
        });
      let missingInfo = [];
      for (const profileName in NOTION_PROPERTY_PROFILES) {
        const profile = NOTION_PROPERTY_PROFILES[profileName];
        const value = parsedIssueInfoRaw[profile.parsedKey];
        if (!profile.isAdequate(value)) {
          missingInfo.push(profile);
        }
      }
      if (missingInfo.length > 0) {
        const interactionState = {
          initialParsedInfoRaw: parsedIssueInfoRaw,
          structuredSlackMessage: structuredSlackMessage,
          missingInfo: missingInfo,
          createdAt: Date.now(),
        };
        try {
          await putPendingInteraction(
            contextIdentifier,
            interactionState,
            PENDING_INTERACTION_TIMEOUT_MS / 1000,
            logger // Pass logger
          );
        } catch (err) {
          logger.error(`[DynamoDB] Error putting pending interaction:`, err);
        }
        const blocks = buildMissingInfoBlocks(missingInfo, parsedIssueInfoRaw);
        await tools_slack.postSlackReply_tool({
          channelId: structuredSlackMessage.channelId,
          messageText:
            "Thanks for reporting this! To log it accurately in Notion, could you please clarify a few things?",
          blocks: blocks,
          threadTimestamp: contextIdentifier,
        });
        return { statusCode: 200, body: "Asked for clarification." };
      }
      await processAndCreateNotionPage(
        parsedIssueInfoRaw,
        structuredSlackMessage,
        null,
        null,
        logger // Pass logger
      );
      return { statusCode: 200, body: "Created Notion issue." };
    } catch (error) {
      logger.error("[MCP CLIENT ERROR] Orchestration failed:", error);
      try {
        await tools_slack.postSlackReply_tool({
          channelId: messagePayload.channel,
          messageText: `:x: Error processing issue: ${error.message}`,
          threadTimestamp: contextIdentifier,
        });
      } catch (slackError) {
        logger.error(
          `Failed to send error reply to slack for context ${contextIdentifier}`,
          slackError
        );
      }
      return { statusCode: 500, body: "Error processing issue." };
    }
  }
  return { statusCode: 200, body: "Event type not handled." };
}

// Lambda Handler: Slack Interactive Webhook
async function slackInteractiveHandler(event, context) {
  let rawBody = event.body;
  if (event.isBase64Encoded)
    rawBody = Buffer.from(rawBody, "base64").toString();
  // Verify Slack signature
  if (!verifySlackSignatureLambda(event, rawBody)) {
    return { statusCode: 400, body: "Signature verification failed" };
  }
  // Parse urlencoded body
  const parsed = parseUrlEncoded(rawBody);
  let payload;
  try {
    payload = JSON.parse(parsed.payload);
  } catch (e) {
    logger.error("[Interaction] Error parsing Slack payload:", e);
    return { statusCode: 200, body: "" }; // Acknowledge Slack
  }
  // Acknowledge Slack immediately - This response is what Slack expects.
  // Do not return other {statusCode, body} from further logic in this handler path for block_actions.
  // If we need to send a message to Slack as a result of an action, it must be done via a Slack API call (e.g. postSlackReply_tool or response_url).

  // Handle Block Actions
  if (
    payload.type === "block_actions" &&
    payload.actions &&
    payload.actions.length > 0
  ) {
    const action = payload.actions[0];
    const contextIdentifierRaw =
      payload.container?.thread_ts || payload.message?.ts;

    if (!contextIdentifierRaw) {
      logger.warn(
        "[Interaction] Block action without thread_ts/message_ts. Cannot identify context."
      );
      return { statusCode: 200, body: "" }; // Acknowledge Slack
    }
    const contextIdentifier = String(contextIdentifierRaw); // Ensure contextIdentifier is a string

    logger.info(
      `[Lambda Interactive Handler] Processing action '${action.action_id}' for context ${contextIdentifier}`
    );
    let interactionState;
    try {
      interactionState = await getPendingInteraction(contextIdentifier, logger); // Pass logger
    } catch (err) {
      logger.error(`[DynamoDB] Error fetching pending interaction:`, err);
      interactionState = null;
    }
    if (!interactionState) {
      logger.warn(
        `[Interaction] Interaction state not found for context ${contextIdentifier}. Action ID: ${action.action_id}`
      );
      if (payload.channel?.id && payload.message?.ts) {
        try {
          await tools_slack.postSlackReply_tool({
            channelId: payload.channel.id,
            messageText:
              ":warning: Sorry, this set of questions/buttons has expired. If you were in the middle of reporting an issue, please send your issue details again to start over.",
            threadTimestamp: payload.message.ts,
          });
        } catch (slackError) {
          logger.error(
            `[Interaction] Failed to send expiry message to Slack for context ${contextIdentifier}:`,
            slackError
          );
        }
      }
      return { statusCode: 200, body: "" }; // Acknowledge Slack
    }
    let fieldUpdated = false;
    const value = action.selected_option?.value || action.value;
    if (action.action_id === "select_priority" && value) {
      interactionState.initialParsedInfoRaw.Priority = value;
      fieldUpdated = true;
    } else if (action.action_id === "select_issue_type" && value) {
      interactionState.initialParsedInfoRaw.IssueType = value;
      fieldUpdated = true;
    }
    // Add more else if blocks here for other interactive elements if any

    if (fieldUpdated) {
      logger.info(
        `[Interaction] Context ${contextIdentifier}: Updated interaction state from button/select:`,
        interactionState.initialParsedInfoRaw
      );
    } else {
      logger.warn(
        `[Interaction] Context ${contextIdentifier}: Unhandled action_id: ${action.action_id}. No state updated.`
      );
      // It's important to still acknowledge Slack even if the action isn't one we specifically handle to update state.
      // The user clicked something, Slack expects a 200 OK.
      return { statusCode: 200, body: "" }; // Acknowledge Slack
    }

    interactionState.missingInfo = interactionState.missingInfo.filter(
      (profile) =>
        !(
          profile.parsedKey === "Priority" &&
          action.action_id === "select_priority"
        ) &&
        !(
          profile.parsedKey === "IssueType" &&
          action.action_id === "select_issue_type"
        )
      // Add checks for other action_ids if they directly map to a missingInfo profile
    );
    interactionState.createdAt = Date.now();
    try {
      await putPendingInteraction(
        contextIdentifier,
        interactionState,
        PENDING_INTERACTION_TIMEOUT_MS / 1000,
        logger // Pass logger
      );
    } catch (err) {
      logger.error(`[DynamoDB] Error updating pending interaction:`, err);
      // Even if DB update fails, acknowledge Slack. We might log an error message to the thread if possible.
      // Consider sending an error message to the user in Slack here.
      return { statusCode: 200, body: "" }; // Acknowledge Slack
    }
    const needsTextReply = interactionState.missingInfo.some(
      (p) =>
        p.parsedKey === "SuccessCriteria" ||
        p.parsedKey === "RootCause" ||
        p.parsedKey === "Title" ||
        p.parsedKey === "Description"
      // Add other fields that are expected via text reply, not buttons
    );
    if (needsTextReply) {
      logger.info(
        `[Interaction] Context ${contextIdentifier} updated by button/select, but still waiting for text replies for other fields. Missing:`,
        interactionState.missingInfo.map((m) => m.displayName)
      );
      // Acknowledge Slack. The bot will re-ask on the next text message if info is still missing.
      return { statusCode: 200, body: "" };
    }
    // If we get here, all info gathered. Proceed to Notion.
    logger.info(
      `[Interaction] All information gathered for context ${contextIdentifier} via interactions/replies. Proceeding to Notion.`
    );
    await processAndCreateNotionPage(
      interactionState.initialParsedInfoRaw,
      interactionState.structuredSlackMessage,
      interactionState,
      contextIdentifier,
      logger // Pass logger
    );
    return { statusCode: 200, body: "" }; // Acknowledge Slack
  } else if (payload.type === "view_submission") {
    logger.info("[Interaction] Received view_submission (modal submitted).");
    // Implement modal submission logic here
    return { statusCode: 200, body: "" }; // Acknowledge Slack
  } else {
    logger.warn(
      "[Interaction] Received unhandled payload type or empty actions:",
      payload.type
    );
    return { statusCode: 200, body: "" };
  }
}

// Export Lambda handlers
module.exports = {
  slackEventHandler,
  slackInteractiveHandler,
};
