# LendLoop

LendLoop is a neighborhood tool library. Visitors can see which tools are available. Signed-in neighbors can list their own tools, request dates, and manage loans.

## Run locally

You need Node.js 22+, Docker Compose, and a Clerk development application. Enable the [Convex integration in Clerk](https://docs.convex.dev/auth/clerk#nextjs) and copy the publishable key, secret key, and Frontend API URL.

```sh
npm ci
npx convex dev
```

Select local development when prompted, or use a Convex development deployment. Keep the command running. In a second terminal, configure the Convex environment. Use a unique random shared secret with at least 32 bytes of entropy.

```sh
npx convex env set CLERK_JWT_ISSUER_DOMAIN 'https://your-clerk-app.clerk.accounts.dev'
npx convex env set LENDLOOP_WEBHOOK_SECRET '<shared-secret>'
npx convex env set N8N_REQUEST_WEBHOOK_URL 'http://127.0.0.1:5678/webhook/lendloop/request-events'
```

Put `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in `.env.local`. Keep the `NEXT_PUBLIC_CONVEX_URL` written by `convex dev`. Set `LENDLOOP_WEBHOOK_SECRET` to the same secret and `CONVEX_SITE_URL` to `http://host.docker.internal:3211` in `.env` for Docker Compose. The site URL is the HTTP actions endpoint, distinct from the browser-facing Convex client URL. Use the actual ports shown by `convex dev` if they differ. `.env.example` lists the names.

```sh
docker compose up -d
npm run dev
```

Open n8n at `http://127.0.0.1:5678` and create a local owner. Import both JSON files under `workflows/`, then publish the request webhook and the daily reminder workflow. The schedule is 09:00 UTC. Use the production webhook URL displayed by n8n. If Convex runs in the cloud, configure an HTTPS n8n URL reachable by the deployment and use the Convex `.convex.site` address in n8n.

Visit `http://localhost:3000`. Use separate Clerk users for a borrower and a lender. For an admin, set `LENDLOOP_ADMIN_SUBJECTS` in Convex to a comma-separated list of Clerk user IDs (`user_…`). Leave it unset if no admin is needed.

## What to try

1. Sign in as the lender and list a tool. In a signed-out window, verify the catalog shows only the tool name and category.
2. Sign in as the borrower, filter the catalog, and request a date range. From the lender account approve it. Verify a conflicting request cannot be approved. Mark the loan returned from Incoming requests.
3. A valid signed request records a mock notification and returns an HTTP receipt with `delivery: "mock"`. A retry with the same event ID returns `duplicate: true`. Invalid or stale signatures fail without processing the event. n8n retains failed executions for inspection.
4. An approved loan whose end date has passed is eligible for the daily workflow. Run it manually in n8n and inspect the summary node. The loan displays the last reminder date. Re-running on the same UTC day does not produce a second reminder.
5. Sign in as an admin. View all loans, mark a lender trusted, and remove a listing. The listing disappears from the catalog and its loans remain in history.

## Design

- **Next.js and Clerk** handle the public catalog and authenticated workspace. The UI gives users feedback on mutations and uses live Convex queries for the current state.
- **Convex** stores listings, loans, trust, reminders, and a notification outbox. Authenticated actions derive the caller from the verified Clerk identity. Server functions enforce ownership, admin privileges, state transitions and approval conflicts. Approvals and overlap checks run in the same transaction.
- **n8n** accepts signed events for requests and state changes. The second workflow gets overdue loans and records a daily reminder claim. Mock notifications make both workflows runnable without an email or Slack account.

## Integration and security

The signature is lowercase HMAC-SHA256 over `${timestamp}.${rawBody}`. Each request carries `x-lendloop-timestamp` in Unix seconds and `x-lendloop-signature`. The receiving workflow or HTTP action verifies the raw body before applying changes. Signed requests have a five-minute validity window. Authentication credentials and the shared secret stay on the server or in the workflow environment.

The public query returns an opaque listing ID for rendering, the name, and the category. It exposes no owner identity, condition, description, or loan records. The webhook receives an event ID, loan ID, opaque recipient reference, tool name, dates and status. Names, email addresses and Clerk IDs stay out of the workflow payload. Reminder writes check eligibility and use one atomic record per loan and UTC day. The mock runs only after that claim succeeds. The demo retains recent webhook receipts in a single n8n instance and serializes production executions. Keep the n8n editor limited to trusted operators because its Code nodes can read environment variables.

## Production changes

- Run Next.js, Convex and n8n in separate environments with HTTPS, restricted admin access, encrypted secrets, backups and monitoring. Use separate signing keys per direction with key IDs for rotation.
- Replace the mock with a delivery provider and an outbox or queue with persisted, provider-side idempotency keys. This closes the gap between claiming a reminder and sending it. Make failed deliveries replayable with access controls and alerts.
- Paginate the catalog and overdue scans, rate-limit requests, and add bounded retention for archived loans and execution payloads. Review the timing and date model with actual users before supporting time zones.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

The Convex tests cover access control, concurrent booking approvals, signed requests, daily reminder claims, and retry IDs. Both workflows were exercised separately in a local n8n 2.47.4 instance. The request webhook handled a valid event, a repeat, a changed body, and a stale signature. The reminder test ran the same processing nodes with a manual trigger against a fixture HTTP server. A complete run with a live Clerk application and both n8n triggers enabled together remains to be checked.
