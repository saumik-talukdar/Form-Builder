export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

/** Trades the refresh cookie for a new session. One call at a time, shared by every request that needs it. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
  })
    .then(async (res) => {
      if (res.status === 409) {
        // Another tab is rotating the token right now; its cookies land in a moment.
        await new Promise((r) => setTimeout(r, 300));
        return true;
      }
      return res.ok;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const NO_REFRESH = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
]);

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "include",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Access tokens are short-lived: on 401 renew the session once and replay the request.
  if (res.status === 401 && !retried && !NO_REFRESH.has(path)) {
    if (await refreshSession()) return request<T>(method, path, body, true);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? res.statusText ?? "Request failed",
      data?.details,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) =>
    request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  delete: <T = void>(path: string, body?: unknown) =>
    request<T>("DELETE", path, body),
};

/** One readable sentence for any error, including field-level validation details. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (Array.isArray(err.details) && err.details.length > 0) {
      const first = err.details[0] as {
        path?: string;
        message?: string;
        fieldId?: string;
      };
      const where = first.path || first.fieldId;
      return where
        ? `${err.message}: ${where} ${first.message ?? ""}`.trim()
        : err.message;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}
