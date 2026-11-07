import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { guestSchema, rumVitalSchema } from "@festival/shared";
import type { Store } from "../../store";
import type { SQLiteStoryRunStore } from "../../infrastructure/sqlite/story-run-store";
import type { StoryCatalog } from "./stories/ports/story-catalog";

export function createPlatformRoutes(deps: {
  store: Store;
  stories: StoryCatalog;
  runs: SQLiteStoryRunStore;
  production: boolean;
  adminToken?: string;
}) {
  const app = new Hono();
  const attempts = new Map<string, { count: number; until: number }>();

  app.get("/health", (c) => c.json({ ok: true }));
  app.post("/guest", async (c) => {
    // The app has no trusted-proxy configuration yet; do not trust a client-supplied IP header.
    const ip = "global";
    const now = Date.now();
    let attempt = attempts.get(ip);
    if (!attempt || attempt.until < now) {
      attempt = { count: 0, until: now + 60000 };
      attempts.set(ip, attempt);
    }
    if (++attempt.count > 30) return c.json({ error: "잠시 후 다시 시도해 줘." }, 429);
    const existing = deps.store.authenticate(getCookie(c, "festival_guest"));
    if (existing) return c.json({ me: existing });
    const { nickname } = guestSchema.parse(await c.req.json());
    if (deps.store.authenticateSession(getCookie(c, "festival_guest"))) return c.json({ error: "닉네임 설정을 먼저 완료해 줘." }, 409);
    if (!deps.store.nicknameAvailable(nickname)) return c.json({ error: "이미 사용 중인 닉네임이야." }, 409);
    const me = deps.store.createGuest(nickname);
    const token = deps.store.issue(me.id);
    setCookie(c, "festival_guest", token, {
      httpOnly: true,
      secure: deps.production,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 86400,
    });
    return c.json({ me }, 201);
  });
  app.post("/analytics/vitals", async (c) => {
    const vital = rumVitalSchema.parse(await c.req.json());
    const story = deps.stories.get(vital.storyId);
    if (!story || story.story.mode !== "solo")
      return c.json({ error: "측정할 스토리를 찾을 수 없어." }, 404);
    deps.runs.recordVital({
      id: crypto.randomUUID(),
      storyId: vital.storyId,
      metricName: vital.metricName,
      value: vital.value,
      navigationId: vital.navigationId,
      route: vital.route,
      occurredAt: new Date().toISOString(),
    });
    return c.body(null, 202);
  });
  app.get("/admin/stories/:id/metrics", (c) => {
    if (!deps.adminToken)
      return c.json({ error: "관리자 통계 API가 설정되지 않았어." }, 503);
    if (c.req.header("authorization") !== `Bearer ${deps.adminToken}`)
      return c.json({ error: "관리자 인증이 필요해." }, 401);
    return c.json(deps.runs.metrics(c.req.param("id")));
  });

  return app;
}
