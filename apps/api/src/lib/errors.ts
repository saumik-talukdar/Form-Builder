import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { isProd } from "../config";

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, msg, details);
export const unauthorized = (msg = "Authentication required") =>
  new AppError(401, msg);
export const notFound = (msg = "Not found") => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  if (err instanceof AppError) {
    res
      .status(err.status)
      .json({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    return;
  }
  // body-parser errors (invalid JSON, payload too large)
  if (
    typeof err?.status === "number" &&
    err.status >= 400 &&
    err.status < 500
  ) {
    res
      .status(err.status)
      .json({
        error:
          err.type === "entity.too.large" ? "Payload too large" : "Bad request",
      });
    return;
  }
  console.error(err);
  res
    .status(500)
    .json({
      error: "Internal server error",
      ...(isProd ? {} : { detail: String(err?.message ?? err) }),
    });
};
