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
    let title =
      rawSlackText.substring(0, 70) + (rawSlackText.length > 70 ? "..." : "");
    let rootCause = "N/A";
    let priority = "Medium"; // Default priority

    let pictureUrl =
      attachments && attachments.length > 0
        ? attachments[0].image_url ||
          attachments[0].thumb_url ||
          "simulated_pic_url.jpg"
        : "No picture attached";

    const rcMatch = rawSlackText.match(/RC:|Root Cause:(.*)/i);
    if (rcMatch && rcMatch[1]) {
      rootCause = rcMatch[1].trim();
      title = rawSlackText.substring(0, rcMatch.index).trim();
    }

    // Detect phrases like "unsure of root cause" or "unknown root cause"
    if (/unsure of root cause|unknown root cause/i.test(rawSlackText)) {
      rootCause = "Unclear";
    }

    // Extract priority keywords (high|medium|low|critical|p0|p1|p2|p3|p4)
    if (/\b(high|critical|urgent|p0|p1)\b/i.test(rawSlackText)) {
      priority = "High";
    } else if (/\b(low|minor|p3|p4)\b/i.test(rawSlackText)) {
      priority = "Low";
    } else if (/\b(?:medium|p2)\b/i.test(rawSlackText)) {
      priority = "Medium";
    }

    // Attempt to clean title by removing leading severity statements like "This is a medium bug." etc.
    let cleanedTitle = rawSlackText;
    cleanedTitle = cleanedTitle.replace(/unsure of root cause.*/i, "").trim();
    cleanedTitle = cleanedTitle.replace(
      /this is a\s+(?:\w+\s+)?(?:bug|issue|problem)\.\s*/i,
      ""
    );
    cleanedTitle = cleanedTitle.replace(/^\s+|\s+$/g, "");
    if (cleanedTitle) {
      title = cleanedTitle;
    }

    const titleMatch = rawSlackText.match(
      /TITLE:(.*?)(?:\||RC:|Root Cause:|$)/i
    );
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
    }

    const structuredData = {
      title: title,
      description: rawSlackText,
      rootCause: rootCause,
      pictureUrl: pictureUrl,
      originalText: rawSlackText,
      priority: priority,
    };
    logger.tool("Processing", "Parsed data:", structuredData);

    if (openai) {
      const prompt = `You are an expert issue triage assistant. Read the Slack message below and extract structured data for a Notion issue tracker. Output a JSON object with these keys:

Title: A concise summary of the main problem or request, omitting severity words (e.g., "high/medium bug") and filler phrases (e.g., "This is a"). Use sentence case.
Description: The full original Slack message.
Root Cause: If the message gives a root cause (e.g., after "RC:" or "Root Cause:"), extract it. If the message says the root cause is unknown/unclear/unsure, set to "Unclear". If not mentioned, set to "N/A".
Issue Type: One of Bug, Incident, Task, Test. If the message describes a user-facing error, malfunction, or unexpected behavior, use "Bug". If it describes an outage or major disruption, use "Incident". If it is a request or action item, use "Task". If it is about testing, use "Test".
Priority: One of High, Medium, Low. Infer from words like "critical", "urgent", "high" (→ High), "medium", "p2" (→ Medium), "low", "minor", "p3" (→ Low). If not specified, use your best judgment based on impact. Default to Medium if unsure.
Success Criteria: If the message specifies what success looks like, extract it. Otherwise, set to "N/A".
Resolution: If the message specifies a resolution, extract it. Otherwise, set to "N/A".
Picture URL: If there is an attachment, use its URL. Otherwise, "No picture attached".
originalText: The raw Slack message.

If the message is ambiguous, conversational, or missing details, use your best judgment to fill in the fields sensibly.

Examples:
1. Slack Message: "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module"
   Output:
   {
     "Title": "Cannot get the valve to open on the adsorb side of the module",
     "Description": "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module",
     "Root Cause": "Unclear",
     "Issue Type": "Bug",
     "Priority": "High",
     "Success Criteria": "N/A",
     "Resolution": "N/A",
     "Picture URL": "No picture attached",
     "originalText": "This is a high priority issue, we can't get the valve to open up on the adsorb side of the module"
   }
2. Slack Message: "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment."
   Output:
   {
     "Title": "Login page down for all users",
     "Description": "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment.",
     "Root Cause": "Database migration failed.",
     "Issue Type": "Incident",
     "Priority": "High",
     "Success Criteria": "Users can log in again.",
     "Resolution": "Rolled back the faulty deployment.",
     "Picture URL": "No picture attached",
     "originalText": "Critical: Login page down for all users. RC: Database migration failed. Success: Users can log in again. Resolution: Rolled back the faulty deployment."
   }
3. Slack Message: "The pump is making a weird noise again. We fixed it by restarting the controller."
    Output:
    {
      "Title": "Pump is making a weird noise",
      "Description": "The pump is making a weird noise again. We fixed it by restarting the controller.",
      "Root Cause": "N/A",
      "Issue Type": "Bug",
      "Priority": "Medium",
      "Success Criteria": "N/A",
      "Resolution": "Fixed by restarting the controller.",
      "Picture URL": "No picture attached",
      "originalText": "The pump is making a weird noise again. We fixed it by restarting the controller."
    }

Slack Message:
${rawSlackText}

Return ONLY valid JSON.`;

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4.1-2025-04-14",
          messages: [{ role: "user", content: prompt }],
        });
        logger.tool(
          "Processing",
          "Parsed data:",
          response.choices[0].message.content
        );
        return JSON.parse(response.choices[0].message.content);
      } catch (error) {
        logger.error(
          "[MCP TOOL ERROR: OpenAI] Failed to parse Slack message:",
          error.body || error.message
        );
        throw new Error(
          `OpenAI API error parsing Slack message: ${error.message}`
        );
      }
    } else {
      logger.warn(
        "OpenAI client not initialized. Using mock parseIssueFromSlackText_tool."
      );
      return structuredData;
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
    if (
      messagePayload.text &&
      (messagePayload.text.startsWith(
        ":white_check_mark: Issue successfully logged as"
      ) ||
        messagePayload.text.startsWith(":x: Error processing issue:") ||
        messagePayload.text.startsWith("Issue logged in")) // legacy
    ) {
      logger.info("[MCP CLIENT LOG] Ignoring own confirmation/error message.");
      return res.status(200).send("Ignoring confirmation message");
    }

    logger.info("[MCP CLIENT LOG] Processing message event:", messagePayload);

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

      const parsedIssueInfo =
        await tools_processing.parseIssueFromSlackText_tool({
          rawSlackText: structuredSlackMessage.text,
          attachments: structuredSlackMessage.attachments,
        });
      logger.info(
        "[MCP CLIENT LOG] Step 2: Parsed Issue Info:",
        parsedIssueInfo
      );

      // --- Normalize casing differences between fallback and OpenAI outputs ---
      const issueTitle =
        parsedIssueInfo.Title || parsedIssueInfo.title || "Untitled";
      const issueDescription =
        parsedIssueInfo.Description || parsedIssueInfo.description || "";
      const issueRootCause =
        parsedIssueInfo["Root Cause"] || parsedIssueInfo.rootCause || "N/A";
      const issuePictureUrl =
        parsedIssueInfo["Picture URL"] ||
        parsedIssueInfo.pictureUrl ||
        "No picture attached";
      const issueType =
        parsedIssueInfo["Issue Type"] || parsedIssueInfo.issueType || "Task";
      const issuePriority =
        parsedIssueInfo["Priority"] || parsedIssueInfo.priority || "Medium";
      const issueSuccessCriteria =
        parsedIssueInfo["Success Criteria"] ||
        parsedIssueInfo.successCriteria ||
        "N/A";
      const issueResolution =
        parsedIssueInfo.Resolution || parsedIssueInfo.resolution;

      const triageDetails = await tools_processing.determineTriageCategory_tool(
        {
          structuredIssueData: parsedIssueInfo,
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
        let resolutionContent = ""; // Default to empty
        if (
          issueResolution &&
          issueResolution.trim() !== "" &&
          issueResolution.toUpperCase() !== "N/A"
        ) {
          resolutionContent = issueResolution.trim();
        }

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
            rich_text: [{ text: { content: resolutionContent } }],
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

        notionPageDetails = await tools_notion.createNotionPage_tool({
          targetDatabaseId: triageDetails.targetDatabaseId, // This now comes from the single NOTION_DATABASE_ID via triage tool
          pageProperties: pageProperties,
        });
        logger.info(
          "[MCP CLIENT LOG] Step 5: Notion Page Created/Details:",
          notionPageDetails
        );
      }

      // Post a confirmation reply ONLY when a new page is created
      if (!existingNotionPage) {
        const replyMessage = `:white_check_mark: Issue successfully logged as *${triageDetails.issueType}* in Notion: <${notionPageDetails.url}|Open in Notion>`;
        await tools_slack.postSlackReply_tool({
          channelId: structuredSlackMessage.channelId,
          messageText: replyMessage,
          threadTimestamp: structuredSlackMessage.timestamp,
        });
        logger.info("[MCP CLIENT LOG] Step 6: Posted feedback to Slack.");
      }

      logger.info("[MCP CLIENT LOG] --- Orchestration Complete ---");
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
