import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config";
import { errorHandler, notFound } from "./lib/errors";
import { authRouter } from "./routes/auth";
import { formsRouter } from "./routes/forms";
import { publicRouter } from "./routes/public";

export function createApp() {
  const app = express();

  // Needed so req.ip is the real client IP behind a proxy / CDN.
  app.set("trust proxy", config.TRUST_PROXY);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGIN.split(",").map((o) => o.trim()),
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/forms", formsRouter);
  app.use("/api/public", publicRouter);

  app.use("/api", () => {
    throw notFound("Route not found");
  });
  app.use(errorHandler);

  return app;
}
