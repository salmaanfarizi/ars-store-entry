/**
 * The browser never talks to Google: the function checks the team passcode, then calls the
 * Apps Script web app in apps-script/entry.gs, which is protected by a shared secret.
 *
 *   ENTRY_SCRIPT_URL     the Apps Script web app URL (…/exec)
 *   ENTRY_SCRIPT_SECRET  the same value as the SECRET Script Property of entry.gs
 *   APP_PASSCODE         the team passcode
 */

/** Apps Script cold starts can take several seconds; give it room but not forever. */
const SCRIPT_TIMEOUT_MS = 25_000;

export const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });

export const env = (key: string) => Netlify.env.get(key)?.trim() || "";

export const scriptConfigured = () =>
  Boolean(env("ENTRY_SCRIPT_URL") && env("ENTRY_SCRIPT_SECRET"));

export type ScriptReply = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

export async function callScript(
  init: { method: "GET"; params?: Record<string, string> } | { method: "POST"; body: unknown },
) {
  const url = new URL(env("ENTRY_SCRIPT_URL"));
  const secret = env("ENTRY_SCRIPT_SECRET");
  if (init.method === "GET") {
    url.searchParams.set("secret", secret);
    for (const [k, v] of Object.entries(init.params ?? {})) url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT_MS);
  try {
    // Apps Script answers with a redirect to the result, which fetch follows (as a GET,
    // which is what Google expects).
    const res = await fetch(url, {
      method: init.method,
      redirect: "follow",
      signal: controller.signal,
      headers: init.method === "POST" ? { "content-type": "application/json" } : undefined,
      body: init.method === "POST" ? JSON.stringify({ ...(init.body as object), secret }) : undefined,
    });
    const text = await res.text();
    let reply: ScriptReply;
    try {
      reply = JSON.parse(text) as ScriptReply;
    } catch {
      // A login page or an HTML error means the deployment's access isn't "Anyone".
      throw new Error(
        "The sheet's entry script didn't answer properly — check it is deployed as a web app with access for Anyone.",
      );
    }
    if (!reply.ok) {
      throw new Error(
        reply.error === "unauthorized"
          ? "The entry script rejected the site's secret — ENTRY_SCRIPT_SECRET must match the SECRET Script Property."
          : (reply.error ?? "The sheet refused the change."),
      );
    }
    return reply;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("The sheet took too long to answer. Try again in a moment.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function authorize(req: Request): Response | null {
  const expected = env("APP_PASSCODE");
  if (!expected) {
    return json({ message: "Writes are disabled: APP_PASSCODE is not configured." }, 503);
  }
  if (req.headers.get("x-app-passcode") !== expected) {
    return json({ message: "Wrong passcode." }, 401);
  }
  return null;
}

export const text = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
