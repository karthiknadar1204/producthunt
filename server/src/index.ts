import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import producthuntRouter from "./routers/producthunt.router";
import { logger } from 'hono/logger'

const app = new Hono();
app.use(logger())
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";
app.use(
  "*",
  cors({
    origin: clientOrigin,
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.get("/", (c) => c.text("Hello Hono!"));
app.get("/health", (c) =>
  c.json({ status: "ok", message: "Server is running" })
);

app.route("/producthunt", producthuntRouter);

export default {
  port: Number(process.env.PORT) || 3004,
  fetch: app.fetch,
  idleTimeout: 255, // max allowed by Bun (seconds) for long-running requests
};
