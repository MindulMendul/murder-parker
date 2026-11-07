import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { bodyLimit } from "hono/body-limit";
import { resolve } from "node:path";
import { Store } from "./store";
import { Game } from "./game";
import { metrics, observeHTTP } from "./observability";
import { storyCatalog } from "./modules/platform/stories/catalog";
import { fileStoryCatalog } from "./modules/platform/stories/file-catalog";
import { SQLiteStoryRunStore } from "./infrastructure/sqlite/story-run-store";
import { SQLiteWorkshopStore } from "./infrastructure/sqlite/workshop-store";
import { PlayStoryCatalog } from "./modules/platform/stories/play-catalog";
import { StorySessionService } from "./modules/game/story-session-service";
import { createAccountRoutes } from "./modules/platform/account-routes";
import { createPlatformRoutes } from "./modules/platform/routes";
import { createWorkshopRoutes } from "./modules/workshop/routes";
import { createGameRoutes } from "./modules/game/routes";
import { createLobbyRoutes } from "./modules/lobby/routes";

const production = process.env.NODE_ENV === "production";
if (production && !process.env.APP_ORIGIN)
  throw Error("APP_ORIGIN is required in production");

export const store = new Store(
  process.env.DATABASE_PATH ?? "./data/festival.sqlite",
);
export const game = new Game(store, storyCatalog);
const storyRunStore = new SQLiteStoryRunStore(store.db);
const workshopStore = new SQLiteWorkshopStore(store.db);
const playCatalog = new PlayStoryCatalog(fileStoryCatalog, workshopStore);
const storySessions = new StorySessionService(playCatalog, storyRunStore);

const notifyTemporal = (action: "start" | "event" | "end", payload: object) => {
  const baseUrl = process.env.TEMPORAL_GATEWAY_URL;
  const token = process.env.TEMPORAL_GATEWAY_TOKEN;
  if (!baseUrl || !token) return;
  void fetch(new URL(`/internal/sessions/${action}`, baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).then((response) => {
    if (!response.ok)
      console.error(`Temporal session notification failed: ${response.status}`);
  }).catch((error) => {
    console.error("Temporal session notification failed", error);
  });
};

const app = new Hono();
app.use("*", observeHTTP);
const allowed = (origin: string, url: string) =>
  origin === (process.env.APP_ORIGIN ?? new URL(url).origin) ||
  (!production &&
    ["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin));

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "요청이 너무 커." }, 413),
  }),
);
app.use("*", async (c, next) => {
  if (
    (c.req.method !== "GET" && c.req.method !== "HEAD") ||
    c.req.path === "/api/lobby/ws"
  ) {
    const origin = c.req.header("origin");
    if (!origin || !allowed(origin, c.req.url))
      return c.json({ error: "허용되지 않은 요청 출처야." }, 403);
  }
  await next();
});

const lobby = createLobbyRoutes({ store, game, notifyTemporal });
const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.APP_ORIGIN
  ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, origin: new URL(process.env.APP_ORIGIN).origin }
  : undefined;
app.route("/api/platform", createAccountRoutes({ store, production, google, onLogout: lobby.disconnect, googleDemo: process.env.GOOGLE_AUTH_DEMO === "true" }));
app.route("/api/platform", createPlatformRoutes({
  store,
  stories: playCatalog,
  runs: storyRunStore,
  production,
  adminToken: process.env.STORY_ADMIN_TOKEN,
}));
app.route("/api/workshop", createWorkshopRoutes({
  stories: fileStoryCatalog,
  store,
  workshop: workshopStore,
  runs: storyRunStore,
}));
app.route("/api/game", createGameRoutes({
  stories: playCatalog,
  runs: storyRunStore,
  sessions: storySessions,
}));
app.route("/api/lobby", lobby.app);

app.get("/metrics", (c) => {
  const token = process.env.METRICS_BEARER_TOKEN;
  if (!token || c.req.header("authorization") !== `Bearer ${token}`)
    return c.text("Not found", 404);
  return c.text(metrics(lobby.connectionCount()), 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});
// Health stays at a stable platform-independent path for container probes.
app.get("/api/health", (c) => c.json({ ok: true }));
app.onError((error, c) =>
  c.json(
    {
      error:
        error.name === "ZodError" || error instanceof SyntaxError
          ? "입력 내용을 확인해 줘."
          : error.message,
    },
    400,
  ),
);
app.notFound((c) => c.json({ error: "찾을 수 없는 경로야." }, 404));

const webRoot = resolve(import.meta.dir, "../../web/dist");
app.use("*", serveStatic({ root: webRoot }));
app.get("*", async (c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/"))
    return c.json({ error: "찾을 수 없는 경로야." }, 404);
  // Existing pages and assets were handled by serveStatic, including directory indexes.
  const file = Bun.file(resolve(webRoot, "404.html"));
  return (await file.exists())
    ? c.html(await file.text(), 404)
    : c.text("Run bun run build first.", 503);
});

export default {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "127.0.0.1",
  fetch: app.fetch,
  websocket: lobby.websocket,
};
