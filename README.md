# Tallymark

A form and survey platform. Owners sign in to build and publish forms; respondents are anonymous. TypeScript throughout: Express 5, Mongoose and Zod on the server, React on the client, in an npm-workspaces monorepo.

```
packages/shared   Zod field definitions + schema compiler, used by the API and the browser
apps/api          Express + Mongoose + Socket.IO
apps/web          React (Vite): form builder, public form, results dashboard
```

## Run it

```bash
npm install
cp apps/api/.env.example apps/api/.env   # set JWT_SECRET and IP_HASH_SECRET
# needs MongoDB (MONGODB_URI) and Redis (REDIS_URL): `docker compose up -d` starts both

# terminal 1: API on :4000 (reads apps/api/.env)
npm run dev:api
# terminal 2: web on :5173 (proxies /api and /socket.io to the API)
npm run dev:web
```

Open http://localhost:5173, create an account, build a form, publish it, and open the link in a private window to answer it. Watch the Results page update.

```bash
npm test            # shared + API + web
npm run typecheck
npm run build:web
```

### Load test data and `explain()`

```bash
npm run seed -- --count 150000 --days 90 --reset   # demo@tallymark.dev / demo-password-123, form /f/seed-demo
npm run explain -- --out explain-report.md         # chosen plan vs forced full scan, per query
npm run explain -- --check                         # exit 1 on any COLLSCAN (usable in CI)
```

The seed is deterministic (`--seed`), writes with the native driver in batches of 5,000, and shapes traffic like a real campaign (weekday and hour patterns, spikes, shared campus IPs, mobile-heavy devices). Views stay within 80 days so the 90-day TTL does not remove them. `explain` covers the response list, a 7-day range, the duplicate check, per-version reads and the real `$facet` analytics pipeline. It needs a real MongoDB: stand-ins such as FerretDB return no plan statistics, and `--check` fails in that case rather than passing silently.

### Integration tests

```bash
TEST_MONGODB_URI=mongodb://127.0.0.1:27019 TEST_REDIS_URL=redis://127.0.0.1:6380 npm run test:integration -w @fb/api
```

They run the real Express app against a throwaway database (19 flows plus rate limits). Against a FerretDB stand-in set `TEST_STANDIN=1`, which skips the two tests that need real MongoDB (the `$facet` analytics endpoint and the atomic `maxResponses` cap). Rate limits are configurable with `READ_RATE_LIMIT_PER_MIN`, `SUBMIT_RATE_LIMIT_PER_MIN` and `AUTH_RATE_LIMIT_PER_15MIN`.

## Sessions and accounts

- **Access token:** a 15-minute JWT in an httpOnly cookie (`ACCESS_TOKEN_TTL_SECONDS`). Verified without a database call.
- **Refresh token:** an opaque random token in a separate httpOnly cookie scoped to `/api/auth`, valid 30 days. **Rotated on every use**: each token works once and returns a new one. Only SHA-256 hashes are stored, in Redis, with a TTL.
- **Theft detection:** a spent token presented again after a 10 s grace window (two tabs racing) revokes the whole session. The grace check and the "spend" step are one atomic Lua script, so concurrent refreshes produce exactly one winner (tested with 10 in parallel).
- **Revocation:** logout, "sign out" on a device, "sign out other devices", changing the password (keeps this device) and deleting the account all end sessions server-side. An already-issued access token still works until it expires, so revocation takes effect within 15 minutes at most. That is the usual trade-off for stateless access tokens.
- **Profile page (`/account`):** change email and password (both require the current password), list devices, sign devices out, delete the account with all its forms and responses.
- The browser client renews an expired session on the first 401 (one shared refresh for all in-flight requests) and replays the request, so users never see the 15-minute expiry. Open live dashboards keep their socket until it reconnects, then refresh the session first.

## How it works

1. **Define.** An owner creates a form and edits a *draft* (`Form.draftFields`).
2. **Publish.** Publishing validates the draft and copies it into an immutable `FormVersion`. Editing the draft afterwards never affects a live form.
3. **Respond.** `GET /api/public/forms/:slug` serves the published version. `POST .../responses` validates answers against *that exact version* with a validator compiled at runtime from the field definitions (`compileForm`), then stores them with the version number.
4. **Watch.** The server pushes a `response:new` event over Socket.IO to the owner's dashboard, which redraws the tally and refreshes its numbers.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register`, `/login`, `/logout` | – | Owner account (httpOnly JWT cookie) |
| GET | `/api/auth/me` | owner | Current user |
| POST/GET | `/api/forms` | owner | Create / list forms |
| GET/PATCH/DELETE | `/api/forms/:id` | owner | Read / edit draft + settings / delete |
| POST | `/api/forms/:id/publish` | owner | Snapshot draft as the next version |
| POST | `/api/forms/:id/close` | owner | Stop accepting responses |
| GET | `/api/forms/:id/versions[/:n]` | owner | Version history |
| GET | `/api/forms/:id/responses?limit&cursor` | owner | Cursor-paginated responses |
| GET | `/api/forms/:id/analytics?version&from&to&interval&timezone` | owner | Summary, time series, breakdowns, funnel, per-question stats |
| GET | `/api/forms/:id/export.csv?version&from&to` | owner | Streamed CSV export |
| GET | `/api/public/forms/:slug` | none | Published form for a respondent |
| POST | `/api/public/forms/:slug/responses` | none | Anonymous submission |
| WS | `/socket.io` → `subscribe(formId)` | owner | Live `response:new` events for a form you own |

Field types: `short_text`, `long_text`, `number`, `select`, `multi_select`, `rating`, `date`, with optional `showIf` conditions. File upload is deliberately out of scope for this version (a separate build adds it; design notes are in the roadmap).

## Web app

- **Builder.** Edit title, description and questions; reorder with up/down buttons (keyboard friendly), duplicate, delete. Conditions ("only when an earlier answer matches") are limited to earlier questions, and deleting a question clears conditions that pointed at it. Saves are validated in the browser with the same schema the server uses, so errors read as "Question 3: …" before any request is sent. Preview shows the real renderer. Unsaved changes trigger a leave-page warning.
- **Public form.** `FormRenderer` evaluates conditions with the shared `visibleFieldIds` and validates with the shared `compileForm`, so what a respondent sees is exactly what the server checks. Errors appear beside the question, focus moves to the first one, and a server-side 422 maps back onto the right fields. A hidden honeypot field catches simple bots.
- **Results.** The response count is drawn as tally marks (groups of five, capped at 100 marks) and updates live. Below it: summary tiles, responses per day, device / browser / OS / country / referrer / language breakdowns, the view-to-response funnel, per-question charts, and the latest responses. CSV download is one click.

