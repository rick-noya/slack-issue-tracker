// DynamoDB helper for PendingInteractions state management
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");

const TABLE_NAME =
  process.env.PENDING_INTERACTIONS_TABLE || "SlackInteractionState";
const REGION = process.env.AWS_REGION || "us-west-1";

const client = new DynamoDBClient({ region: REGION });

function marshallItem(item) {
  // Simple marshaller for basic types (string, number, object as JSON)
  const marshalled = {};
  for (const key in item) {
    const value = item[key];
    if (typeof value === "string") marshalled[key] = { S: value };
    else if (typeof value === "number")
      marshalled[key] = { N: value.toString() };
    else if (typeof value === "object" && value !== null)
      marshalled[key] = { S: JSON.stringify(value) };
    else if (typeof value === "boolean") marshalled[key] = { BOOL: value };
    else if (value === null || value === undefined) continue;
    else
      throw new Error(
        `Unsupported type for DynamoDB marshalling: ${typeof value}`
      );
  }
  return marshalled;
}

function unmarshallItem(item) {
  if (!item) return null;
  const unmarshalled = {};
  for (const key in item) {
    if (item[key].S !== undefined) {
      // Try to parse JSON, fallback to string
      try {
        unmarshalled[key] = JSON.parse(item[key].S);
      } catch {
        unmarshalled[key] = item[key].S;
      }
    } else if (item[key].N !== undefined) {
      unmarshalled[key] = Number(item[key].N);
    } else if (item[key].BOOL !== undefined) {
      unmarshalled[key] = item[key].BOOL;
    }
  }
  return unmarshalled;
}

async function getPendingInteraction(contextIdentifier, logger) {
  const key = String(contextIdentifier);
  logger.debug(`[DynamoDB] Getting item with key: ${key}`);
  const cmd = new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { contextIdentifier: { S: key } },
  });
  try {
    const result = await client.send(cmd);
    const item = unmarshallItem(result.Item);
    logger.debug(
      `[DynamoDB] GetItem result for key ${key}:`,
      item ? "Found" : "NotFound"
    );
    return item;
  } catch (error) {
    logger.error(`[DynamoDB] Error getting item for key ${key}:`, error);
    throw error; // Re-throw after logging
  }
}

async function putPendingInteraction(
  contextIdentifier,
  data,
  ttlSeconds,
  logger
) {
  const now = Date.now();
  const ttl = ttlSeconds ? Math.floor(now / 1000) + ttlSeconds : undefined;
  const key = String(contextIdentifier);
  const item = {
    ...data,
    contextIdentifier: key,
    createdAt: now,
    ...(ttl ? { ttl } : {}),
  };
  logger.debug(
    `[DynamoDB] Putting item with key ${key}:`,
    JSON.stringify(item)
  ); // Log stringified item
  const cmd = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshallItem(item),
  });
  try {
    await client.send(cmd);
    logger.info(`[DynamoDB] PutItem successful for key: ${key}`);
    return item;
  } catch (error) {
    logger.error(`[DynamoDB] Error putting item for key ${key}:`, error);
    throw error;
  }
}

async function updatePendingInteraction(contextIdentifier, updates, logger) {
  const key = String(contextIdentifier); // Explicitly ensure key is a string
  logger.debug(`[DynamoDB] Attempting to update item with key: ${key}`);
  // Pass logger to getPendingInteraction
  const existing = await getPendingInteraction(key, logger);
  if (!existing) {
    logger.error(`[DynamoDB] Update failed: Item not found for key ${key}`);
    throw new Error("Interaction not found");
  }

  const updatedData = { ...existing, ...updates };

  // Pass logger to putPendingInteraction
  // Calculate remaining TTL or use a default if needed
  const existingTTL = existing.ttl;
  let ttlSeconds = PENDING_INTERACTION_TIMEOUT_MS / 1000; // Default timeout
  if (existingTTL) {
    const remainingSeconds = existingTTL - Math.floor(Date.now() / 1000);
    if (remainingSeconds > 0) {
      ttlSeconds = remainingSeconds;
    }
  }
  await putPendingInteraction(key, updatedData, ttlSeconds, logger);
  logger.info(`[DynamoDB] Update successful (via put) for key: ${key}`);
  return updatedData;
}

async function deletePendingInteraction(contextIdentifier, logger) {
  const key = String(contextIdentifier);
  logger.debug(`[DynamoDB] Deleting item with key: ${key}`);
  const cmd = new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: { contextIdentifier: { S: key } },
  });
  try {
    await client.send(cmd);
    logger.info(`[DynamoDB] DeleteItem successful for key: ${key}`);
  } catch (error) {
    logger.error(`[DynamoDB] Error deleting item for key ${key}:`, error);
    throw error;
  }
}

// Add completed marker support
async function markInteractionCompleted(contextIdentifier, logger) {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + 24 * 60 * 60; // 24 hours
  const item = {
    contextIdentifier: String(contextIdentifier),
    status: "completed",
    completedAt: now,
    ttl,
  };
  if (logger)
    logger.info(`[DynamoDB] Marking context ${contextIdentifier} as completed`);
  const cmd = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshallItem(item),
  });
  await client.send(cmd);
}

async function isInteractionCompleted(contextIdentifier, logger) {
  const key = String(contextIdentifier);
  const cmd = new GetItemCommand({
    TableName: TABLE_NAME,
    Key: { contextIdentifier: { S: key } },
    ConsistentRead: true,
  });
  const result = await client.send(cmd);
  const item = unmarshallItem(result.Item);
  if (logger)
    logger.debug(`[DynamoDB] isInteractionCompleted for ${key}:`, item);
  return item && item.status === "completed";
}

module.exports = {
  getPendingInteraction,
  putPendingInteraction,
  updatePendingInteraction,
  deletePendingInteraction,
  markInteractionCompleted,
  isInteractionCompleted,
};

// Define PENDING_INTERACTION_TIMEOUT_MS here if needed for TTL recalculation, or pass it in
const PENDING_INTERACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (copied from index.js, consider centralizing)
