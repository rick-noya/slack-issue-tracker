const express = require("express");
const bodyParser = require("body-parser");
const { Client } = require("@notionhq/client"); // Import Notion Client
const OpenAI = require("openai"); // Import OpenAI Client
const { WebClient } = require("@slack/web-api"); // Import Slack WebClient

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

app.use(bodyParser.json());

// --- Mock Data Stores (In-memory for demo) ---
let notionPages = {}; // Store mock Notion pages: { "slack_permalink_id": { pageId: "...", url: "..." } }
let issueCounter = 0;

// --- Simple In-Memory State Store for Pending Interactions ---
// WARNING: This data is lost on server restart. Use a persistent store (DB, Redis, etc.) for production.
let pendingInteractions = {}; // Key: original_message_ts, Value: { initialParsedInfoRaw, structuredSlackMessage, missingInfo, createdAt }
const PENDING_INTERACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup old pending interactions periodically
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
  postSlackReply_tool: async ({ channelId, messageText, threadTimestamp }) => {
    logger.tool(
      "Slack",
      `postSlackReply_tool: Replying to channel ${channelId} (Thread: ${
        threadTimestamp || "N/A"
      }): "${messageText}"`
    );
    if (slackWebClient) {
      try {
        const result = await slackWebClient.chat.postMessage({
          channel: channelId,
          text: messageText,
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
      const prompt = `You are an expert issue triage assistant. Read the Slack message below and extract structured data for a Notion issue tracker. Output a JSON object with these keys:

Title: A concise summary of the main problem or request. If unclear, use "UNKNOWN_TITLE". Use sentence case.
Description: The full original Slack message.
RootCause: If the message gives a root cause, extract it. If the message says the root cause is unknown/unclear/unsure, set to "Unclear". If not mentioned at all, set to "UNKNOWN_ROOT_CAUSE". If the user explicitly states "N/A", use "N/A".
IssueType: One of Bug, Incident, Task, Test. If not clearly inferable, use "UNKNOWN_ISSUE_TYPE".
Priority: One of High, Medium, Low. If not clearly inferable, use "UNKNOWN_PRIORITY".
SuccessCriteria: If the message specifies what success looks like, extract it. If not mentioned, set to "UNKNOWN_SUCCESS_CRITERIA". If the user explicitly states "N/A", use "N/A".
Resolution: If the message specifies a resolution, extract it. If not mentioned, set to "UNKNOWN_RESOLUTION". If the user explicitly states "N/A", use "N/A".
PictureURL: If there is an attachment, use its URL. Otherwise, "No picture attached".
originalText: The raw Slack message.

IMPORTANT: Do NOT default to values like "Medium" for Priority or "Task" for IssueType if you are unsure. Use the "UNKNOWN_" variants.

Examples:
1. Slack Message: "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module"
   Output:
   {
     "Title": "Cannot get the valve to open on the adsorb side of the module",
     "Description": "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module",
     "RootCause": "Unclear",
     "IssueType": "Bug",
     "Priority": "High",
     "SuccessCriteria": "UNKNOWN_SUCCESS_CRITERIA",
     "Resolution": "UNKNOWN_RESOLUTION",
     "PictureURL": "No picture attached",
     "originalText": "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module"
   }
2. Slack Message: "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment."
   Output:
   {
     "Title": "Login page down for all users",
     "Description": "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment.",
     "RootCause": "Database migration failed.",
     "IssueType": "Incident",
     "Priority": "High",
     "SuccessCriteria": "Users can log in again.",
     "Resolution": "Rolled back the faulty deployment.",
     "PictureURL": "No picture attached",
     "originalText": "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment."
   }
3. Slack Message: "The pump is making a weird noise again. We fixed it by restarting the controller. Not sure what criteria for success would be, N/A for now."
    Output:
    {
      "Title": "Pump is making a weird noise",
      "Description": "The pump is making a weird noise again. We fixed it by restarting the controller. Not sure what criteria for success would be, N/A for now.",
      "RootCause": "UNKNOWN_ROOT_CAUSE",
      "IssueType": "Bug",
      "Priority": "UNKNOWN_PRIORITY",
      "SuccessCriteria": "N/A",
      "Resolution": "Fixed by restarting the controller.",
      "PictureURL": "No picture attached",
      "originalText": "The pump is making a weird noise again. We fixed it by restarting the controller. Not sure what criteria for success would be, N/A for now."
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
        "originalText": "Need to order more coffee."
   }

Slack Message:
${rawSlackText}

Return ONLY valid JSON.`;

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
        return JSON.parse(response.choices[0].message.content);
      } catch (error) {
        logger.error(
          "[MCP TOOL ERROR: OpenAI] Failed to parse Slack message:",
          error.body || error.message
        );
        logger.warn("Falling back to basic parsing due to OpenAI error.");
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
      .map((q) => `- ${q.displayName}: ${q.question}`)
      .join("\n");
    const originalJson = JSON.stringify(originalParsedInfo, null, 2);

    const prompt = `You are updating issue details based on a user's reply. The original parsed information was:
\`\`\`json
${originalJson}
\`\`\`

The user was asked to clarify the following fields based on these questions:
${questionList}

Their reply is: "${userReplyText}"

Update the original JSON data based *only* on the information provided in the user's reply regarding the fields asked about. Preserve the original values for fields that were *not* asked about. If the user's reply doesn't clearly answer a specific question asked, keep the original value (which might be an 'UNKNOWN_' placeholder) for that field. 

Output the complete, updated JSON object. Ensure the output is ONLY the valid JSON object.`;

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
      const updatedParsedInfo = JSON.parse(extractedJsonString);
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
// This endpoint simulates a Slack Event API webhook.
// IMPORTANT: Real Slack webhooks should be verified using SLACK_SIGNING_SECRET.
app.post("/webhook/slack/event", async (req, res) => {
  logger.info("\n--- [MCP CLIENT LOG] Received Slack Event Webhook ---");
  const slackEventPayload = req.body;

  // TODO: Add Slack request verification using SLACK_SIGNING_SECRET
  // const { verifyRequestSignature } = require('@slack/events-api');
  // verifyRequestSignature({
  //   signingSecret: SLACK_SIGNING_SECRET,
  //   requestSignature: req.headers['x-slack-signature'],
  //   requestTimestamp: req.headers['x-slack-request-timestamp'],
  //   body: req.rawBody // Requires raw body parser middleware
  // });

  if (
    slackEventPayload.type === "event_callback" &&
    slackEventPayload.event &&
    slackEventPayload.event.type === "message"
  ) {
    if (
      slackEventPayload.event.bot_id ||
      slackEventPayload.event.subtype === "bot_message" ||
      slackEventPayload.event.subtype === "message_changed" ||
      slackEventPayload.event.subtype === "message_deleted"
    ) {
      logger.info(
        `[MCP CLIENT LOG] Ignoring event with subtype: ${
          slackEventPayload.event.subtype || "bot_id event"
        }.`
      );
      return res.status(200).send("Ignoring event due to subtype.");
    }

    const messagePayload = slackEventPayload.event;

    // --- Check if this is a reply to a tracked thread ---
    if (
      messagePayload.thread_ts &&
      pendingInteractions[messagePayload.thread_ts]
    ) {
      const interactionState = pendingInteractions[messagePayload.thread_ts];
      const originalMessageTs = messagePayload.thread_ts; // For clarity
      logger.info(
        `[MCP CLIENT LOG] Received reply for tracked thread: ${originalMessageTs}`
      );

      // Acknowledge Slack immediately before processing
      res.status(200).json({ message: "Reply received, processing..." });

      try {
        // --- Phase 2 - Step 6: Process User's Answers ---
        const userReplyText = messagePayload.text;
        logger.info(`[MCP CLIENT LOG] Processing reply: "${userReplyText}"`);

        const updatedParsedInfoRaw =
          await tools_processing.parseAnswersAndUpdate_tool({
            userReplyText: userReplyText,
            originalParsedInfo: interactionState.initialParsedInfoRaw,
            questionsAsked: interactionState.missingInfo,
          });

        logger.info(
          "[MCP CLIENT LOG] Step 2 Updated: Parsed Issue Info (Raw) after reply:",
          updatedParsedInfoRaw
        );

        // TODO: Optional: Re-evaluate gaps based on updatedParsedInfoRaw. For now, assume one round is enough.
        // We will now proceed to Notion creation using the updated info.

        // --- Continue workflow from Step 2.5 using UPDATED info ---
        const structuredSlackMessage = interactionState.structuredSlackMessage; // Get original message details
        const normalizedPermalink = canonicalizeSlackPermalink(
          structuredSlackMessage.permalink
        );

        // Normalize based on the *updated* raw info
        const issueTitle =
          updatedParsedInfoRaw.Title !== "UNKNOWN_TITLE"
            ? updatedParsedInfoRaw.Title || "Untitled Issue"
            : "Untitled Issue";
        const issueDescription =
          updatedParsedInfoRaw.Description ||
          updatedParsedInfoRaw.originalText ||
          "";
        const issueRootCause =
          updatedParsedInfoRaw.RootCause !== "UNKNOWN_ROOT_CAUSE"
            ? updatedParsedInfoRaw.RootCause || "N/A"
            : "N/A";
        const issuePictureUrl =
          updatedParsedInfoRaw.PictureURL || "No picture attached";
        const issueType =
          updatedParsedInfoRaw.IssueType !== "UNKNOWN_ISSUE_TYPE"
            ? updatedParsedInfoRaw.IssueType || "Task"
            : "Task";
        const issuePriority =
          updatedParsedInfoRaw.Priority !== "UNKNOWN_PRIORITY"
            ? updatedParsedInfoRaw.Priority || "Medium"
            : "Medium";
        const issueSuccessCriteria =
          updatedParsedInfoRaw.SuccessCriteria !== "UNKNOWN_SUCCESS_CRITERIA"
            ? updatedParsedInfoRaw.SuccessCriteria || "N/A"
            : "N/A";
        const issueResolution =
          updatedParsedInfoRaw.Resolution !== "UNKNOWN_RESOLUTION"
            ? updatedParsedInfoRaw.Resolution || ""
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
          originalText: updatedParsedInfoRaw.originalText,
        };

        logger.info(
          "[MCP CLIENT LOG] Step 2.5 Updated: Data for Triage (Post-Reply & Normalization):",
          currentIssueDataForTriage
        );

        const triageDetails =
          await tools_processing.determineTriageCategory_tool({
            structuredIssueData: currentIssueDataForTriage,
          });
        logger.info(
          "[MCP CLIENT LOG] Step 3 Updated: Triage Details:",
          triageDetails
        );

        const existingNotionPage =
          await tools_notion.findNotionPageBySlackLink_tool({
            slackMessagePermalink: normalizedPermalink,
          });
        logger.info(
          "[MCP CLIENT LOG] Step 4 Updated: Existing Notion Page Check:",
          existingNotionPage
        );

        let notionPageDetails;
        if (existingNotionPage) {
          logger.info(
            `[MCP CLIENT LOG] Issue already logged in Notion: ${existingNotionPage.url}. Consider implementing update logic.`
          );
          notionPageDetails = existingNotionPage;
          // TODO: Optionally update existing page here
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
            "Root Cause": {
              rich_text: [{ text: { content: issueRootCause } }],
            },
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
                  external: {
                    url: file.permalink,
                  },
                }))
                .filter((f) => f.external.url), // Ensure we only add files with a permalink
            };
            // Limit to a reasonable number if necessary (e.g., Notion API limits)
            if (pageProperties["Files"].files.length > 10) {
              logger.warn(
                `[Notion Files] More than 10 attachments found, only linking the first 10.`
              );
              pageProperties["Files"].files = pageProperties[
                "Files"
              ].files.slice(0, 10);
            }
            // Remove the property if no valid files were found after filtering
            if (pageProperties["Files"].files.length === 0) {
              delete pageProperties["Files"];
            }
          }

          notionPageDetails = await tools_notion.createNotionPage_tool({
            targetDatabaseId: triageDetails.targetDatabaseId,
            pageProperties: pageProperties,
          });
          logger.info(
            "[MCP CLIENT LOG] Step 5 Updated: Notion Page Created/Details:",
            notionPageDetails
          );
        }

        // --- Step 6: Post Final Feedback ---
        if (notionPageDetails && notionPageDetails.url) {
          const replyMessage = existingNotionPage
            ? `:information_source: This issue was already logged here: <${notionPageDetails.url}|Open in Notion>`
            : `:white_check_mark: Issue successfully logged as *${triageDetails.issueType}* in Notion (Priority: ${issuePriority}): <${notionPageDetails.url}|Open in Notion>`;

          await tools_slack.postSlackReply_tool({
            channelId: structuredSlackMessage.channelId,
            messageText: replyMessage,
            threadTimestamp: structuredSlackMessage.timestamp, // Reply to original thread
          });
          logger.info(
            "[MCP CLIENT LOG] Step 6 Updated: Posted final feedback to Slack."
          );
        }

        logger.info("[MCP CLIENT LOG] --- Reply Processing Complete --- B");
      } catch (error) {
        logger.error("[MCP CLIENT ERROR] Failed to process user reply:", error);
        // Attempt to notify the user in the thread about the error
        try {
          await tools_slack.postSlackReply_tool({
            channelId: interactionState.structuredSlackMessage.channelId,
            messageText: `:x: Sorry, I encountered an error trying to process your reply: ${error.message}`,
            threadTimestamp: originalMessageTs,
          });
        } catch (slackError) {
          logger.error(
            "Failed to send error reply to slack about reply processing failure",
            slackError
          );
        }
      } finally {
        // --- Crucial: Cleanup state after processing (success or fail) ---
        logger.info(
          `[State Cleanup] Removing pending interaction for thread: ${originalMessageTs}`
        );
        delete pendingInteractions[originalMessageTs];
      }

      // Stop processing after handling the reply
      return;
    }
    // --- End Check for Reply ---

    // If it's not a reply to a tracked thread, process as a new message
    logger.info(
      "[MCP CLIENT LOG] Processing new message event:",
      messagePayload
    );

    try {
      const structuredSlackMessage =
        await tools_slack.receiveSlackIssueMessage_tool({
          user: messagePayload.user,
          text: messagePayload.text,
          channel: messagePayload.channel,
          ts: messagePayload.ts,
          attachments: messagePayload.files || [],
        });
      logger.info(
        "[MCP CLIENT LOG] Step 1: Structured Slack Message:",
        structuredSlackMessage
      );

      // Raw parsed info from LLM (or fallback)
      const parsedIssueInfoRaw =
        await tools_processing.parseIssueFromSlackText_tool({
          rawSlackText: structuredSlackMessage.text,
          attachments: structuredSlackMessage.attachments,
        });
      logger.info(
        "[MCP CLIENT LOG] Step 2: Initial Parsed Issue Info (Raw):",
        parsedIssueInfoRaw
      );

      // --- Gap Analysis ---
      let missingInfo = [];
      for (const profileName in NOTION_PROPERTY_PROFILES) {
        const profile = NOTION_PROPERTY_PROFILES[profileName];
        const value = parsedIssueInfoRaw[profile.parsedKey];
        if (!profile.isAdequate(value)) {
          missingInfo.push(profile);
        }
      }

      if (missingInfo.length > 0) {
        logger.info(
          "[MCP CLIENT LOG] Missing information identified, asking user:",
          missingInfo.map((p) => ({
            field: p.displayName,
            question: p.question,
          }))
        );

        // Store state for this interaction
        const interactionKey = structuredSlackMessage.timestamp; // Original message ts is the thread key
        pendingInteractions[interactionKey] = {
          initialParsedInfoRaw: parsedIssueInfoRaw,
          structuredSlackMessage: structuredSlackMessage,
          missingInfo: missingInfo,
          createdAt: Date.now(),
        };
        logger.info(
          `[State Store] Stored pending interaction for thread: ${interactionKey}`
        );

        // Format the questions
        let questionText =
          "Thanks for reporting this! To log it accurately in Notion, could you please clarify a few things?\n";
        missingInfo.forEach((profile) => {
          questionText += `\n- ${profile.question}`;
        });
        questionText += "\n\nReply in this thread with the answers.";

        // Ask the questions in a thread reply
        await tools_slack.postSlackReply_tool({
          channelId: structuredSlackMessage.channelId,
          messageText: questionText,
          threadTimestamp: structuredSlackMessage.timestamp,
        });
        logger.info(
          `[MCP CLIENT LOG] Asked clarifying questions in thread ${interactionKey}. Waiting for reply.`
        );

        // Important: End processing here. We wait for the user's reply event.
        res.status(200).json({ message: "Asking user for clarification." });
        return;
      }

      // --- If no missing info, proceed directly to Notion creation ---
      logger.info(
        "[MCP CLIENT LOG] No missing information identified, proceeding to Notion creation."
      );

      // --- Normalize casing and provide defaults AFTER gap analysis ---
      // (This section now only runs if there was no missing info initially)
      const issueTitle =
        parsedIssueInfoRaw.Title !== "UNKNOWN_TITLE"
          ? parsedIssueInfoRaw.Title || "Untitled Issue"
          : "Untitled Issue";
      const issueDescription =
        parsedIssueInfoRaw.Description || parsedIssueInfoRaw.originalText || ""; // Description should be originalText
      const issueRootCause =
        parsedIssueInfoRaw.RootCause !== "UNKNOWN_ROOT_CAUSE"
          ? parsedIssueInfoRaw.RootCause || "N/A"
          : "N/A";
      const issuePictureUrl =
        parsedIssueInfoRaw.PictureURL || "No picture attached";
      const issueType =
        parsedIssueInfoRaw.IssueType !== "UNKNOWN_ISSUE_TYPE"
          ? parsedIssueInfoRaw.IssueType || "Task"
          : "Task"; // Default to Task if still unknown after prompt
      const issuePriority =
        parsedIssueInfoRaw.Priority !== "UNKNOWN_PRIORITY"
          ? parsedIssueInfoRaw.Priority || "Medium"
          : "Medium"; // Default to Medium if still unknown
      const issueSuccessCriteria =
        parsedIssueInfoRaw.SuccessCriteria !== "UNKNOWN_SUCCESS_CRITERIA"
          ? parsedIssueInfoRaw.SuccessCriteria || "N/A"
          : "N/A";
      const issueResolution =
        parsedIssueInfoRaw.Resolution !== "UNKNOWN_RESOLUTION"
          ? parsedIssueInfoRaw.Resolution || ""
          : "";

      // Pass the potentially modified/defaulted values to triage
      const currentIssueDataForTriage = {
        Title: issueTitle,
        Description: issueDescription, // Pass original text as description
        "Root Cause": issueRootCause,
        "Issue Type": issueType,
        Priority: issuePriority,
        "Success Criteria": issueSuccessCriteria,
        "Picture URL": issuePictureUrl,
        Resolution: issueResolution, // from user, or ""
        originalText: parsedIssueInfoRaw.originalText, // ensure original text is available for triage
      };

      logger.info(
        "[MCP CLIENT LOG] Step 2.5: Data for Triage (Post-Normalization/Defaults):",
        currentIssueDataForTriage
      );

      const triageDetails = await tools_processing.determineTriageCategory_tool(
        {
          // Pass the structured data that includes normalized/defaulted values.
          // The triage tool might also need to be aware of "UNKNOWN_" values if it's to make finer decisions.
          // For now, it uses the defaulted values.
          structuredIssueData: currentIssueDataForTriage,
        }
      );
      logger.info("[MCP CLIENT LOG] Step 3: Triage Details:", triageDetails);

      // Normalize the permalink BEFORE using it for search or storage
      const normalizedPermalink = canonicalizeSlackPermalink(
        structuredSlackMessage.permalink
      );

      const existingNotionPage =
        await tools_notion.findNotionPageBySlackLink_tool({
          slackMessagePermalink: normalizedPermalink, // Use normalized permalink for search
        });
      logger.info(
        "[MCP CLIENT LOG] Step 4: Existing Notion Page Check:",
        existingNotionPage
      );

      let notionPageDetails;
      if (existingNotionPage) {
        logger.info(
          `[MCP CLIENT LOG] Issue already logged in Notion: ${existingNotionPage.url}. Consider updating it.`
        );
        notionPageDetails = existingNotionPage;
        // Optionally update:
        // const updatedProps = { "Status": { select: { name: "Re-opened" } } }; // Example
        // await tools_notion.updateNotionPage_tool({ pageId: existingNotionPage.pageId, propertiesToUpdate: updatedProps });
      } else {
        let resolutionContentForNotion = issueResolution;

        // Construct properties according to Notion's expected schema
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
          "Link to Slack Message": {
            url: normalizedPermalink, // Use normalized permalink for storage
          },
          "Date Identified": {
            date: {
              start: new Date(
                parseFloat(structuredSlackMessage.timestamp) * 1000
              ).toISOString(),
            },
          },
          Reporter: { people: [] }, // Optionally map from Slack user
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

        // Add Files property if attachments exist (using original message attachments)
        if (
          structuredSlackMessage.attachments &&
          structuredSlackMessage.attachments.length > 0
        ) {
          pageProperties["Files"] = {
            files: structuredSlackMessage.attachments
              .map((file) => ({
                name: file.name || file.title || "Slack Attachment",
                type: "external",
                external: {
                  url: file.permalink,
                },
              }))
              .filter((f) => f.external.url), // Ensure we only add files with a permalink
          };
          // Limit to a reasonable number if necessary (e.g., Notion API limits)
          if (pageProperties["Files"].files.length > 10) {
            logger.warn(
              `[Notion Files] More than 10 attachments found, only linking the first 10.`
            );
            pageProperties["Files"].files = pageProperties["Files"].files.slice(
              0,
              10
            );
          }
          // Remove the property if no valid files were found after filtering
          if (pageProperties["Files"].files.length === 0) {
            delete pageProperties["Files"];
          }
        }

        notionPageDetails = await tools_notion.createNotionPage_tool({
          targetDatabaseId: triageDetails.targetDatabaseId, // This now comes from the single NOTION_DATABASE_ID via triage tool
          pageProperties: pageProperties,
        });
        logger.info(
          "[MCP CLIENT LOG] Step 5: Notion Page Created/Details:",
          notionPageDetails
        );
      }

      // Post a confirmation reply ONLY when a new page is created OR if we successfully updated one (if update logic added)
      // Ensure we are replying to the correct thread (original message timestamp)
      if (notionPageDetails && notionPageDetails.url) {
        // Check if we have details (either created or found/updated)
        const replyMessage = existingNotionPage
          ? `:information_source: This issue was already logged here: <${notionPageDetails.url}|Open in Notion>`
          : `:white_check_mark: Issue successfully logged as *${triageDetails.issueType}* in Notion: <${notionPageDetails.url}|Open in Notion>`;

        await tools_slack.postSlackReply_tool({
          channelId: structuredSlackMessage.channelId,
          messageText: replyMessage,
          threadTimestamp: structuredSlackMessage.timestamp, // Always reply to the original message thread
        });
        logger.info("[MCP CLIENT LOG] Step 6: Posted feedback to Slack.");
      }

      logger.info("[MCP CLIENT LOG] --- Orchestration Complete --- A");
      res.status(200).json({
        success: true,
        message: "Issue processed",
        notionUrl: notionPageDetails.url,
      });
    } catch (error) {
      logger.error("[MCP CLIENT ERROR] Orchestration failed:", error);
      try {
        await tools_slack.postSlackReply_tool({
          channelId: messagePayload.channel,
          messageText: `:x: Error processing issue: ${error.message}`,
          threadTimestamp: messagePayload.ts,
        });
      } catch (slackError) {
        logger.error("Failed to send error reply to slack", slackError);
      }
      res.status(500).json({ success: false, error: error.message });
    }
  } else {
    if (slackEventPayload.challenge) {
      logger.info(
        "[MCP CLIENT LOG] Responding to Slack URL verification challenge."
      );
      return res.status(200).send(slackEventPayload.challenge);
    }
    logger.info(
      "[MCP CLIENT LOG] Received non-message or unhandled event type:",
      slackEventPayload.type
    );
    res.status(200).send("Event type not handled by this demo.");
  }
});

app.get("/", (req, res) => {
  res.send(
    `MCP Slack-Notion Demo App is running! Current LOG_LEVEL: ${LOG_LEVEL}. Notion DB ID: ${NOTION_DATABASE_ID}. POST to /webhook/slack/event to simulate a Slack message.`
  );
});

app.listen(PORT, () => {
  logger.info(`MCP Demo App listening on port ${PORT}`);
  logger.info(`LOG_LEVEL is set to: ${LOG_LEVEL}`);
  logger.info(`Using Notion Database ID: ${NOTION_DATABASE_ID}`);
  logger.info(
    "To test, send a POST request to http://localhost:${PORT}/webhook/slack/event with a JSON body like the example in README.md"
  );
});

// Helper function to normalize Slack permalinks by removing query parameters
const canonicalizeSlackPermalink = (permalink) => {
  if (typeof permalink !== "string") {
    return permalink; // Or handle error appropriately
  }
  return permalink.split("?")[0];
};
