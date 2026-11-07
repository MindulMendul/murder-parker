import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { getConnInfo } from "hono/bun";
import { guestSchema, nicknameSchema, type Guest } from "@festival/shared";
import type { Store } from "../../store";

export type GoogleConfig = { clientId: string; clientSecret: string; origin: string };
export function createAccountRoutes(deps: {
  store: Store; production: boolean; google?: GoogleConfig; googleDemo?: boolean;
  onLogout?: (id: string) => void;
  fetch?: (url: string, options?: RequestInit) => Promise<Response>;
}) {
  const app = new Hono();
  const cookieOptions = { httpOnly: true, secure: deps.production, sameSite: "Lax" as const, path: "/", maxAge: 30 * 86400 };
  const session = (c: Context) => deps.store.authenticateSession(getCookie(c, "festival_guest"));
  const profile = (me: Guest | null) => ({ me, accountType: me ? deps.store.accountType(me.id) : null, needsNickname: !!me && !me.nickname });
  const signIn = (c: Context, me: Guest) => {
    setCookie(c, "festival_guest", deps.store.issue(me.id), cookieOptions);
  };
  const demo = !deps.production && deps.googleDemo === true;

  const request = deps.fetch ?? fetch;
  let demoAttempts = 0, demoUntil = 0;
  const nicknameAttempts = new Map<string, { count: number; until: number }>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/account", (c) => c.json(profile(session(c))));
  app.get("/auth/config", (c) => c.json({ google: !!deps.google, demo }));
  app.get("/nicknames/availability", (c) => {
    // Use authenticated identity or transport IP, never client-supplied forwarded headers.
    // Anonymous callers behind one proxy share its IP; unknown transports share one fallback.
    const me = session(c);
    let address: string | undefined;
    if (!me) {
      try { address = getConnInfo(c).remote.address; }
      catch { /* Non-Bun callers have no transport address and use the bounded fallback. */ }
    }
    const key = me ? `account:${me.id}` : `ip:${address ?? "unknown"}`;
    const now = Date.now();
    let attempt = nicknameAttempts.get(key);
    if (!attempt || now >= attempt.until) {
      if (nicknameAttempts.size >= 4096) {
        for (const [client, bucket] of nicknameAttempts) if (bucket.until <= now) nicknameAttempts.delete(client);
        if (!nicknameAttempts.has(key) && nicknameAttempts.size >= 4096) {
          c.header("Retry-After", "60");
          return c.json({ error: "잠시 후 다시 시도해 줘." }, 429);
        }
      }
      attempt = { count: 0, until: now + 60000 };
      nicknameAttempts.set(key, attempt);
    }
    if (++attempt.count > 60) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((attempt.until - now) / 1000))));
      return c.json({ error: "잠시 후 다시 시도해 줘." }, 429);
    }
    const parsed = nicknameSchema.safeParse(c.req.query("nickname"));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]!.message }, 400);
    return c.json({ available: deps.store.nicknameAvailable(parsed.data, me?.id) });
  });
  app.post("/account/nickname", async (c) => {
    const me = session(c);
    if (!me) return c.json({ error: "로그인이 필요해." }, 401);
    const { nickname } = guestSchema.parse(await c.req.json());
    if (deps.store.inRoom(me.id)) return c.json({ error: "방에서 나온 뒤 닉네임을 변경해 줘." }, 409);
    if (!deps.store.nicknameAvailable(nickname, me.id)) return c.json({ error: "이미 사용 중인 닉네임이야." }, 409);
    deps.store.rename(me, nickname);
    return c.json(profile(me));
  });
  app.post("/account/logout", (c) => {
    const me = session(c);
    if (me && deps.store.inRoom(me.id)) return c.json({ error: "방에서 나온 뒤 로그아웃해 줘." }, 409);
    if (me) { deps.store.logout(me); deps.onLogout?.(me.id); }
    deleteCookie(c, "festival_guest", cookieOptions);
    return c.json({ ok: true });
  });
  app.post("/account/delete", (c) => {
    const me = session(c);
    if (!me) return c.json({ error: "로그인이 필요해." }, 401);
    if (deps.store.inRoom(me.id)) return c.json({ error: "방에서 나온 뒤 회원탈퇴해 줘." }, 409);
    deps.store.deleteAccount(me);
    deps.onLogout?.(me.id);
    deleteCookie(c, "festival_guest", cookieOptions);
    deleteCookie(c, "festival_google_demo", cookieOptions);
    deleteCookie(c, "festival_oauth_state", cookieOptions);
    return c.json({ ok: true });
  });
  app.post("/auth/google/demo", (c) => {
    if (!demo) return c.json({ error: "임시 로그인은 개발 환경에서만 사용할 수 있어." }, 503);
    if (Date.now() >= demoUntil) { demoAttempts = 0; demoUntil = Date.now() + 60000; }
    if (++demoAttempts > 30) return c.json({ error: "잠시 후 다시 시도해 줘." }, 429);
    if (session(c)) return c.json({ error: "먼저 로그아웃해 줘." }, 409);
    let subject = getCookie(c, "festival_google_demo");
    if (!subject || !/^[0-9a-f-]{36}$/.test(subject)) subject = crypto.randomUUID();
    setCookie(c, "festival_google_demo", subject, cookieOptions);
    const me = deps.store.googleAccount(`demo:${subject}`);
    signIn(c, me);
    return c.json(profile(me));
  });
  app.get("/auth/google", async (c) => {
    const config = deps.google;
    if (!config) return c.json({ error: "구글 로그인 설정이 필요해. 게스트 로그인을 이용해 줘." }, 503);
    if (session(c)) return c.json({ error: "먼저 로그아웃해 줘." }, 409);
    const now = Date.now();
    const state = crypto.randomUUID();
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const locale = c.req.query("locale") === "en" ? "en" : "ko";
    await setSignedCookie(c, "festival_oauth_state", JSON.stringify({ state, verifier, expires: now + 600000, locale }), `oauth-state:${config.clientSecret}`, { ...cookieOptions, maxAge: 600 });
    const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${config.origin}/api/platform/auth/google/callback`, response_type: "code", scope: "openid", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get("/auth/google/callback", async (c) => {
    const config = deps.google;
    const state = c.req.query("state");
    let attempt: { state: string; verifier: string; expires: number; locale: string } | undefined;
    if (config) {
      const signed = await getSignedCookie(c, `oauth-state:${config.clientSecret}`, "festival_oauth_state");
      if (signed) { try { attempt = JSON.parse(signed); } catch { /* invalid cookie */ } }
    }
    const home = attempt?.locale === "en" ? "/en/" : "/";
    const pending = attempt && typeof attempt.state === "string" && typeof attempt.verifier === "string" && Number.isFinite(attempt.expires) && attempt.expires > Date.now();
    // Unrelated callbacks must not cancel a live browser-bound attempt in another tab.
    // Expired/malformed cookies and matching (including reused) attempts are cleared.
    if (!pending || state === attempt?.state) deleteCookie(c, "festival_oauth_state", cookieOptions);
    if (!config || !state || !attempt || state !== attempt.state || typeof attempt.verifier !== "string" || !Number.isFinite(attempt.expires) || attempt.expires <= Date.now() || !deps.store.consumeOAuthState(state, attempt.expires))
      return c.redirect(`${home}?auth=failed`);
    if (c.req.query("error")) return c.redirect(`${home}?auth=cancelled`);
    const code = c.req.query("code");
    if (!code || session(c)) return c.redirect(`${home}?auth=failed`);
    let stage = "token_exchange";
    try {
      const tokenResponse = await request("https://oauth2.googleapis.com/token", {
        method: "POST", body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: `${config.origin}/api/platform/auth/google/callback`, grant_type: "authorization_code", code_verifier: attempt.verifier }), signal: AbortSignal.timeout(10000),
      });
      if (!tokenResponse.ok) throw Error("OAuth token exchange failed");
      const token = await tokenResponse.json() as { access_token?: string };
      if (!token.access_token) throw Error("Missing access token");
      stage = "user_lookup";
      const userResponse = await request("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000) });
      if (!userResponse.ok) throw Error("OAuth user lookup failed");
      const user = await userResponse.json() as { sub?: string };
      if (!user.sub || typeof user.sub !== "string" || user.sub.length > 255) throw Error("Missing subject");
      stage = "session_persistence";
      signIn(c, deps.store.googleAccount(`google:${user.sub}`));
      return c.redirect(home);
    } catch {
      // Do not log upstream bodies, exception messages or request URLs: they may contain credentials.
      console.error("Google sign-in failed", { stage });
      return c.redirect(`${home}?auth=failed`);
    }
  });
  return app;
}
