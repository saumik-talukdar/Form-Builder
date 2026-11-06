import { createServer } from "node:http";
import mongoose from "mongoose";
import { config } from "./config";
import { createApp } from "./app";
import { User } from "./models/user";
import { Form } from "./models/form";
import { FormVersion } from "./models/formVersion";
import { ResponseModel } from "./models/response";
import { FormView } from "./models/formView";
import { AUTH_COOKIE } from "./middleware/auth";
import { attachRealtime, closeRealtime } from "./lib/realtime";

async function main() {
  await mongoose.connect(config.MONGODB_URI);
  // Make sure indexes exist before serving traffic.
  await Promise.all(
    [User, Form, FormVersion, ResponseModel, FormView].map((m) => m.init()),
  );

  const server = createServer(createApp());
  attachRealtime(server, {
    origins: config.CORS_ORIGIN.split(",").map((o) => o.trim()),
    jwtSecret: config.JWT_SECRET,
    cookieName: AUTH_COOKIE,
    canSubscribe: async (userId, formId) =>
      Boolean(await Form.exists({ _id: formId, ownerId: userId })),
  });

  server.listen(config.PORT, "0.0.0.0", () => {
    console.log(`API listening on port ${config.PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    void closeRealtime();
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start", err);
  process.exit(1);
});
