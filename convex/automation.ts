import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { isDate, utcToday } from "./domain";
import { signPayload, userRef } from "./signing";

const eventForStatus = {
  pending: "request.created",
  approved: "request.approved",
  declined: "request.declined",
  returned: "request.returned",
} as const;

const backoffMilliseconds = [2_000, 10_000, 60_000, 300_000];

export const overdue = internalQuery({
  args: {},
  handler: async (ctx) => {
    const today = utcToday();
    const overdue = await ctx.db
      .query("loans")
      .withIndex("by_status_and_end_date", (q) =>
        q.eq("status", "approved").lt("endDate", today),
      )
      .collect();
    return overdue
      .filter(
        (loan) =>
          !loan.reminderSentAt ||
          new Date(loan.reminderSentAt).toISOString().slice(0, 10) !== today,
      )
      .map(({ _id: loanId, borrower, toolName, endDate }) => ({
        loanId,
        borrower,
        toolName,
        endDate,
      }));
  },
});

export const recordReminder = internalMutation({
  args: { loanId: v.string(), reminderDate: v.string() },
  handler: async (ctx, { loanId, reminderDate }) => {
    const today = utcToday();
    if (!isDate(reminderDate) || reminderDate !== today)
      return { recorded: false };
    const id = ctx.db.normalizeId("loans", loanId);
    if (!id) return { recorded: false };
    const loan = await ctx.db.get(id);
    if (!loan || loan.status !== "approved" || loan.endDate >= today)
      return { recorded: false };
    const previous = await ctx.db
      .query("reminders")
      .withIndex("by_loan_and_date", (q) =>
        q.eq("loanId", id).eq("reminderDate", reminderDate),
      )
      .unique();
    if (previous) return { recorded: false };
    await ctx.db.insert("reminders", { loanId: id, reminderDate });
    await ctx.db.patch(id, { reminderSentAt: Date.now() });
    return { recorded: true };
  },
});

export const notification = internalQuery({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const deliver = internalAction({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }): Promise<void> => {
    const row: Doc<"notifications"> | null = await ctx.runQuery(
      internal.automation.notification,
      { id },
    );
    if (!row || row.delivery !== "pending") return;
    const endpoint = process.env.N8N_REQUEST_WEBHOOK_URL;
    const secret = process.env.LENDLOOP_WEBHOOK_SECRET;
    let outcome: "delivered" | "retry" | "failed" = "failed";

    if (endpoint && secret) {
      try {
        const rawBody = JSON.stringify({
          eventId: id,
          event: eventForStatus[row.status],
          status: row.status,
          loanId: row.loanId,
          recipientRef: await userRef(secret, row.recipient),
          toolName: row.toolName,
          startDate: row.startDate,
          endDate: row.endDate,
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lendloop-timestamp": timestamp,
            "x-lendloop-signature": await signPayload(
              secret,
              timestamp,
              rawBody,
            ),
          },
          body: rawBody,
          redirect: "error",
        });
        if (response.ok) outcome = "delivered";
        else if (response.status === 429 || response.status >= 500)
          outcome = "retry";
      } catch {
        outcome = "retry";
      }
    }

    await ctx.runMutation(internal.automation.completeAttempt, {
      id,
      attempt: row.attempt,
      outcome,
    });
  },
});

export const completeAttempt = internalMutation({
  args: {
    id: v.id("notifications"),
    attempt: v.number(),
    outcome: v.union(
      v.literal("delivered"),
      v.literal("retry"),
      v.literal("failed"),
    ),
  },
  handler: async (ctx, { id, attempt, outcome }) => {
    const row = await ctx.db.get(id);
    if (!row || row.delivery !== "pending" || row.attempt !== attempt) return;
    const nextAttempt = attempt + 1;
    if (outcome === "delivered") {
      await ctx.db.patch(id, { attempt: nextAttempt, delivery: "delivered" });
      return;
    }
    const delay = backoffMilliseconds[attempt];
    if (outcome === "retry" && delay !== undefined) {
      console.warn("LendLoop notification retry scheduled", {
        id,
        attempt: nextAttempt,
      });
      await ctx.db.patch(id, { attempt: nextAttempt });
      await ctx.scheduler.runAfter(delay, internal.automation.deliver, { id });
      return;
    }
    console.warn("LendLoop notification delivery exhausted", {
      id,
      attempt: nextAttempt,
      outcome,
    });
    await ctx.db.patch(id, { attempt: nextAttempt, delivery: "failed" });
  },
});
