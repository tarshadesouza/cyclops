import { App } from "@octokit/app";

let appInstance: App | undefined;

export function getApp(): App {
  if (!appInstance) {
    const appId = process.env["GITHUB_APP_ID"];
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    const webhookSecret = process.env["GITHUB_WEBHOOK_SECRET"];

    if (!appId || !privateKey || !webhookSecret) {
      throw new Error(
        "Missing required environment variables: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET"
      );
    }

    // Railway stores private key with literal \n — normalize to actual newlines
    const normalizedKey = privateKey.replace(/\\n/g, "\n");

    appInstance = new App({
      appId: parseInt(appId, 10),
      privateKey: normalizedKey,
      webhooks: { secret: webhookSecret },
    });
  }
  return appInstance;
}
