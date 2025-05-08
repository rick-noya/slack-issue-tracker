# MCP Slack-Notion Node.js Docker Demo (with API Keys)

This project demonstrates the MCP architecture for integrating Slack and Notion
for issue tracking. It uses mock tools, runs in a Docker container, and shows
how to manage configuration via environment variables, including placeholders for API keys.

## Prerequisites

- Docker installed and running on your system.

## Project Structure

- `package.json`: Node.js project manifest. Includes `@notionhq/client` for Notion API integration.
- `index.js`: Main application file. Uses `process.env` for configuration and the Notion SDK for API calls.
- `Dockerfile`: Instructions to build the Docker image.
- `README.md`: This file.

## Environment Variables

The application can be configured using the following environment variables:

**Configuration:**

- `PORT`: The port the application will listen on (default: `3000`).
- `LOG_LEVEL`: Controls logging verbosity (e.g., `debug`, `info` - default: `info`).
- `NOTION_DATABASE_ID`: The ID of the Notion database where all issues will be tracked (e.g., `your_notion_database_id_here`).

**Secrets (CRITICAL):**

- `SLACK_BOT_TOKEN`: Your Slack Bot User OAuth Token.
- `SLACK_SIGNING_SECRET`: Your Slack App's Signing Secret (for verifying requests).
- `NOTION_API_KEY`: Your Notion Integration Token (Internal Integration).

**IMPORTANT SECURITY NOTE:**

- **NEVER commit actual API keys or secrets to your version control system (e.g., Git).**
- Use environment variables as shown, or for production, consider using a secrets management service (e.g., HashiCorp Vault, AWS Secrets Manager, Google Secret Manager).
- The `.env` file method mentioned below is for local development convenience and the `.env` file itself should be added to your `.gitignore` file.

## How to Run

1.  **Save the Files:**

    - Create a directory named `mcp-slack-notion-api-demo`.
    - Inside this directory, create `package.json`, `index.js`, and `Dockerfile` with the content provided above.
      - **Important:** For the `Dockerfile` and `README.md` content, remove the leading `/*` and trailing `*/` comment markers and save them as `Dockerfile` and `README.md` respectively.

2.  **Build the Docker Image:**
    Open your terminal, navigate to the `mcp-slack-notion-api-demo` directory, and run:

    ```bash
    docker build -t mcp-slack-notion-api-app .
    ```

3.  **Run the Docker Container with Environment Variables:**
    You can pass environment variables using the `-e` flag or `--env` flag with `docker run`.

    Example (replace placeholder values with your actual mock/test keys if you have them, otherwise the app will note they are missing):

    ```bash
    docker run -p 3001:3000 \
      -e PORT=3000 \
      -e LOG_LEVEL=debug \
      -e NOTION_DATABASE_ID="your_actual_notion_db_id" \
      -e SLACK_BOT_TOKEN="xoxb-your-slack-bot-token-if-testing-real-sdk" \
      -e SLACK_SIGNING_SECRET="your-slack-signing-secret-if-testing-real-sdk" \
      -e NOTION_API_KEY="secret_your-notion-api-key-if-testing-real-sdk" \
      -d --name mcp-api-app mcp-slack-notion-api-app
    ```

    This command:

    - Maps port `3001` on your host to port `3000` inside the container.
    - Sets various configuration and (placeholder) secret environment variables.
    - Runs the container in detached mode (`-d`) and names it `mcp-api-app`.

    If you run `docker logs mcp-api-app`, you should see messages indicating whether the API keys were found.

4.  **Using a `.env` file (for local development):**
    Create a file named `.env` in your `mcp-slack-notion-api-demo` directory:

    ```env
    PORT=3000
    LOG_LEVEL=debug
    NOTION_DATABASE_ID="your_actual_notion_db_id_from_file"

    # Add your actual keys here for local testing if you are integrating SDKs
    # These are placeholders, replace with real values if needed for SDK testing
    SLACK_BOT_TOKEN="xoxb-your-local-slack-bot-token"
    SLACK_SIGNING_SECRET="your-local-slack-signing-secret"
    NOTION_API_KEY="secret_your-local-notion-api-key"
    ```

    **Add `.env` to your `.gitignore` file!**
    Then run the container using the `--env-file` flag:

    ```bash
    docker run -p 3001:3000 --env-file ./.env -d --name mcp-api-app mcp-slack-notion-api-app
    ```

5.  **Test the Application:**
    Send a POST request to `http://localhost:3001/webhook/slack/event` (or your mapped host port).
    The `curl` command from the previous README can be used.

    Example `curl` (assuming you mapped to host port 3001):

    ```bash
    curl -X POST -H "Content-Type: application/json" \
    -d '{
      "type": "event_callback",
      "event": {
        "type": "message",
        "user": "U_API_TESTER",
        "text": "This is a TASK. TITLE: Setup new server | RC: Old server decommissioning.",
        "channel": "C_INFRA_UPDATES",
        "ts": "'$(date +%s.000000)'",
        "files": []
      }
    }' \
    http://localhost:3001/webhook/slack/event
    ```

    Check the Docker logs (`docker logs mcp-api-app`).

6.  **View Logs:**

    ```bash
    docker logs mcp-api-app
    ```

    To follow logs:

    ```bash
    docker logs -f mcp-api-app
    ```

7.  **Stop and Remove the Container:**
    ```bash
    docker stop mcp-api-app
    docker rm mcp-api-app
    ```

## Further Development

- **Integrate Real SDKs:** The project now uses the `@notionhq/client` for real Notion API calls. Slack SDK integration for message posting and verification is still a mock/TODO.
- **Implement Slack Request Verification:** Use the `SLACK_SIGNING_SECRET` to verify that incoming webhook requests are genuinely from Slack. The `@slack/events-api` package (or similar functionality in `@slack/bolt`) provides utilities for this.
- **Notion Database Property**: Ensure your Notion database has a URL property named "Link to Slack Message" for the `findNotionPageBySlackLink_tool` to correctly identify existing pages based on Slack message permalinks.
- Implement robust error handling and retry mechanisms for external API calls.
- Secure your webhook endpoints further if exposed publicly.
- Persist data in a proper database instead of in-memory objects for `notionPages`.
- Break down `index.js` into smaller, more manageable modules.
- Add comprehensive unit and integration tests.
