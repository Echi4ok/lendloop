// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { signPayload } from "./signing";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const listing = {
  name: "Cordless drill",
  category: "Power tools",
  condition: "Good",
  description: "Comes with a case and a charger.",
};
const secret = "test-only-shared-secret";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
  vi.stubEnv("LENDLOOP_ADMIN_SUBJECTS", "user_admin");
  vi.stubEnv("LENDLOOP_WEBHOOK_SECRET", secret);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("public projection hides details and access checks hold across identities", async () => {
  const t = convexTest(schema, modules);
  const lender = t.withIdentity({ subject: "user_lender" });
  const borrower = t.withIdentity({ subject: "user_borrower" });
  const admin = t.withIdentity({ subject: "user_admin" });
  await expect(t.mutation(api.tools.create, listing)).rejects.toThrow(
    "Sign in",
  );
  await expect(t.query(api.tools.dashboard, {})).rejects.toThrow("Sign in");
  const id = await lender.mutation(api.tools.create, listing);
  expect(await t.query(api.tools.publicTools, {})).toEqual([
    { _id: id, name: listing.name, category: listing.category },
  ]);
  await expect(
    borrower.mutation(api.tools.update, { id, ...listing }),
  ).rejects.toThrow("Only the owner");
  await expect(borrower.mutation(api.tools.remove, { id })).rejects.toThrow(
    "Only the owner",
  );
  await expect(
    borrower.mutation(api.tools.trustLender, { id }),
  ).rejects.toThrow("Admin access");
  await admin.mutation(api.tools.trustLender, { id });
  expect(
    (await borrower.query(api.tools.dashboard, {})).tools[0],
  ).toMatchObject({
    _id: id,
    isMine: false,
    isTrusted: true,
    availability: "available",
  });
  await admin.mutation(api.tools.remove, { id });
  expect(await t.query(api.tools.publicTools, {})).toEqual([]);
});

test("pending requests compete without permitting double booking or cross-user actions", async () => {
  const t = convexTest(schema, modules);
  const lender = t.withIdentity({ subject: "user_lender" });
  const borrower = t.withIdentity({ subject: "user_borrower" });
  const other = t.withIdentity({ subject: "user_other" });
  const admin = t.withIdentity({ subject: "user_admin" });
  const toolId = await lender.mutation(api.tools.create, listing);
  const dates = { toolId, startDate: "2026-11-11", endDate: "2026-11-12" };
  await expect(lender.mutation(api.loans.request, dates)).rejects.toThrow(
    "your own tool",
  );
  await expect(
    borrower.mutation(api.loans.request, { ...dates, endDate: "2026-11-31" }),
  ).rejects.toThrow("valid date range");
  const first = await borrower.mutation(api.loans.request, dates);
  await expect(borrower.mutation(api.loans.request, dates)).rejects.toThrow(
    "pending request",
  );
  const second = await other.mutation(api.loans.request, dates);
  await expect(
    borrower.mutation(api.loans.decide, { id: first, decision: "approved" }),
  ).rejects.toThrow("Only the owner");

  const results = await Promise.allSettled(
    [first, second].map((id) =>
      lender.mutation(api.loans.decide, { id, decision: "approved" }),
    ),
  );
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(await t.query(api.tools.publicTools, {})).toEqual([]);
  const { allLoans } = await admin.query(api.tools.dashboard, {});
  const approved = allLoans.find((loan) => loan.status === "approved")!;
  expect(allLoans).toHaveLength(2);
  expect((await other.query(api.tools.dashboard, {})).allLoans).toEqual([]);
  expect((await other.query(api.tools.dashboard, {})).incoming).toEqual([]);
  await expect(
    other.mutation(api.loans.markReturned, { id: approved._id }),
  ).rejects.toThrow("Only the owner");
  await lender.mutation(api.loans.markReturned, { id: approved._id });
  expect(await t.query(api.tools.publicTools, {})).toHaveLength(1);
});

test("signed reminder HTTP routes reject tampering and claim at most once per UTC day", async () => {
  const t = convexTest(schema, modules);
  const loanId = await t.run(async (ctx) => {
    const toolId = await ctx.db.insert("tools", {
      ...listing,
      owner: "user_lender",
      archived: false,
    });
    return ctx.db.insert("loans", {
      toolId,
      toolName: listing.name,
      lender: "user_lender",
      borrower: "user_borrower",
      startDate: "2026-11-09",
      endDate: "2026-11-10",
      status: "approved",
    });
  });
  const request = await signedRequest("{}");
  expect(
    (
      await t.fetch("/automation/overdue", {
        ...request,
        body: '{"tampered":true}',
      })
    ).status,
  ).toBe(401);
  const stale = await signedRequest("{}", Math.floor(Date.now() / 1000) - 301);
  expect((await t.fetch("/automation/overdue", stale)).status).toBe(401);

  const overdue = await t.fetch("/automation/overdue", request);
  expect(await overdue.json()).toEqual({
    loans: [
      {
        loanId,
        toolName: listing.name,
        endDate: "2026-11-10",
        borrowerRef: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ],
  });

  const reminder = await signedRequest(
    JSON.stringify({ loanId, reminderDate: "2026-11-11" }),
  );
  const claims = await Promise.all([
    t.fetch("/automation/reminders", reminder),
    t.fetch("/automation/reminders", reminder),
  ]);
  const results = await Promise.all(claims.map((response) => response.json()));
  expect(results.map((result) => result.recorded).sort()).toEqual([
    false,
    true,
  ]);
  expect(await (await t.fetch("/automation/overdue", request)).json()).toEqual({
    loans: [],
  });

  vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const nextDay = await signedRequest(
    JSON.stringify({ loanId, reminderDate: "2026-11-12" }),
  );
  expect(
    await (await t.fetch("/automation/reminders", nextDay)).json(),
  ).toEqual({ recorded: true });
  expect(
    await t.run((ctx) => ctx.db.query("reminders").collect()),
  ).toHaveLength(2);
});

test("notification delivery retries with a stable signed event and no direct identity", async () => {
  const t = convexTest(schema, modules);
  const lender = t.withIdentity({ subject: "user_lender" });
  const borrower = t.withIdentity({ subject: "user_borrower" });
  vi.stubEnv("N8N_REQUEST_WEBHOOK_URL", "https://n8n.example.test/webhook");
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const toolId = await lender.mutation(api.tools.create, listing);
  const loanId = await borrower.mutation(api.loans.request, {
    toolId,
    startDate: "2026-11-11",
    endDate: "2026-11-12",
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [, first] = fetchMock.mock.calls[0];
  const [, second] = fetchMock.mock.calls[1];
  expect(first?.body).toBe(second?.body);
  expect(first?.body).not.toContain("user_lender");
  expect(first?.body).not.toContain("user_borrower");
  expect(JSON.parse(first?.body as string)).toMatchObject({
    event: "request.created",
    status: "pending",
    loanId,
    toolName: listing.name,
  });
  const headers = new Headers(second?.headers);
  expect(headers.get("x-lendloop-signature")).toBe(
    await signPayload(
      secret,
      headers.get("x-lendloop-timestamp")!,
      second?.body as string,
    ),
  );
  expect(
    await t.run((ctx) => ctx.db.query("notifications").first()),
  ).toMatchObject({
    attempt: 2,
    delivery: "delivered",
  });
});

async function signedRequest(
  rawBody: string,
  seconds = Math.floor(Date.now() / 1000),
) {
  const timestamp = String(seconds);
  return {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-lendloop-timestamp": timestamp,
      "x-lendloop-signature": await signPayload(secret, timestamp, rawBody),
    },
  };
}
