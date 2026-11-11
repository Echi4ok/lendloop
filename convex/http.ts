import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { userRef, verifyPayload } from "./signing";

const http = httpRouter();

http.route({
  path: "/automation/overdue",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedBody(request);
    if (signed instanceof Response) return signed;
    if (Object.keys(signed.body).length)
      return json({ error: "Expected an empty object." }, 400);
    const overdue = await ctx.runQuery(internal.automation.overdue, {});
    const loans = await Promise.all(
      overdue.map(async ({ borrower, ...loan }) => ({
        ...loan,
        borrowerRef: await userRef(signed.secret, borrower),
      })),
    );
    return json({ loans });
  }),
});

http.route({
  path: "/automation/reminders",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedBody(request);
    if (signed instanceof Response) return signed;
    const { loanId, reminderDate } = signed.body;
    if (typeof loanId !== "string" || typeof reminderDate !== "string") {
      return json({ error: "Expected loanId and reminderDate strings." }, 400);
    }
    return json(
      await ctx.runMutation(internal.automation.recordReminder, {
        loanId,
        reminderDate,
      }),
    );
  }),
});

async function readSignedBody(request: Request) {
  const secret = process.env.LENDLOOP_WEBHOOK_SECRET;
  if (!secret) return json({ error: "Automation unavailable." }, 503);
  const rawBody = await request.text();
  if (rawBody.length > 4096)
    return json({ error: "Request is too large." }, 413);
  const verified = await verifyPayload(
    secret,
    request.headers.get("x-lendloop-timestamp"),
    rawBody,
    request.headers.get("x-lendloop-signature"),
  );
  if (!verified) return json({ error: "Invalid signature." }, 401);
  try {
    const body: unknown = JSON.parse(rawBody);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return { secret, body: body as Record<string, unknown> };
    }
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }
  return json({ error: "Expected a JSON object." }, 400);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export default http;
