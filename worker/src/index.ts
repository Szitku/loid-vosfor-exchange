export interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO?: string;
  TRIGGER_SECRET?: string;
}

/**
 * Constant-time string comparison to prevent timing attacks on secrets.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Triggers the GitHub Action workflow via the GitHub repository_dispatch API.
 * Uses only 1 subrequest and completes in ~200ms.
 */
async function triggerGitHubWorkflow(env: Env, reason: string) {
  const repo = env.GITHUB_REPO || "Szitku/loid-vosfor-exchange";
  const token = env.GITHUB_TOKEN;

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN environment secret in Cloudflare Worker.");
  }

  const url = `https://api.github.com/repos/${repo}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "LoidExchange-Cloudflare-Cron-Scheduler",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: "update-market-data",
      client_payload: {
        trigger: reason,
        timestamp: new Date().toISOString(),
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`GitHub API dispatch failed (${res.status}): ${errorText}`);
  }

  return { success: true, timestamp: new Date().toISOString() };
}

export default {
  /**
   * Cloudflare Cron Trigger (Runs every 2 hours: 0 every 2 hours)
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduledTime = new Date(controller.scheduledTime).toISOString();
    console.log(`[Cron Trigger] Triggering GitHub Action at ${scheduledTime}...`);

    try {
      await triggerGitHubWorkflow(env, `cron-${scheduledTime}`);
      console.log(`[Cron Trigger] Successfully dispatched GitHub Action update!`);
    } catch (err: any) {
      console.error(`[Cron Trigger] Failed to dispatch GitHub Action:`, err?.message);
    }
  },

  /**
   * HTTP endpoint for manual triggers, status checks, and health monitoring
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Endpoint: /trigger
    if (url.pathname === "/trigger") {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "x-trigger-secret, Authorization, Content-Type",
          },
        });
      }

      // Restrict allowed HTTP methods
      if (request.method !== "POST" && request.method !== "GET") {
        return Response.json(
          { error: "Method not allowed. Use POST or GET." },
          {
            status: 405,
            headers: {
              Allow: "POST, GET, OPTIONS",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // 1. Fail closed: Reject if TRIGGER_SECRET is not configured on the worker
      if (!env.TRIGGER_SECRET) {
        return Response.json(
          { error: "Forbidden: Manual trigger is disabled because TRIGGER_SECRET is not configured." },
          {
            status: 403,
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      // 2. Extract token from header (x-trigger-secret / Authorization: Bearer <token>) or query parameter
      const authHeader = request.headers.get("authorization");
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
      const token =
        request.headers.get("x-trigger-secret") ||
        bearerToken ||
        url.searchParams.get("token");

      if (!token || !timingSafeEqual(token, env.TRIGGER_SECRET)) {
        return Response.json(
          { error: "Unauthorized: Invalid or missing trigger secret." },
          {
            status: 401,
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }

      try {
        const result = await triggerGitHubWorkflow(env, "manual-http-trigger");
        return Response.json(
          {
            message: "GitHub Action successfully triggered via repository_dispatch!",
            targetRepository: env.GITHUB_REPO || "Szitku/loid-vosfor-exchange",
            timestamp: result.timestamp,
          },
          {
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (err: any) {
        return Response.json(
          { error: "Failed to dispatch workflow", details: err?.message },
          {
            status: 500,
            headers: {
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    // Default info response
    return Response.json(
      {
        name: "Loid Vosfor Exchange - Precision Cron Scheduler",
        service: "Cloudflare Worker -> GitHub Actions Dispatcher",
        cronSchedule: "0 */2 * * * (Every 2 hours)",
        targetRepository: env.GITHUB_REPO || "Szitku/loid-vosfor-exchange",
        eventType: "update-market-data",
        endpoints: {
          manualTrigger: "/trigger (POST with x-trigger-secret header or ?token=...)",
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  },
};
