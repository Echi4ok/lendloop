import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import {
  conflictsWithApproval,
  isDate,
  requireOwner,
  requireViewer,
  utcToday,
} from "./domain";

export const request = mutation({
  args: { toolId: v.id("tools"), startDate: v.string(), endDate: v.string() },
  handler: async (ctx, { toolId, startDate, endDate }) => {
    const viewer = await requireViewer(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.archived) throw new ConvexError("Listing not found.");
    if (tool.owner === viewer.subject)
      throw new ConvexError("You cannot borrow your own tool.");
    const today = utcToday();
    if (
      !isDate(startDate) ||
      !isDate(endDate) ||
      startDate < today ||
      endDate < startDate
    ) {
      throw new ConvexError(
        "Choose a valid date range starting today or later.",
      );
    }

    const approved = await loansForTool(ctx, toolId, "approved");
    if (conflictsWithApproval(approved, startDate, endDate, today)) {
      throw new ConvexError("This tool is unavailable for those dates.");
    }
    const pending = await loansForTool(ctx, toolId, "pending");
    if (
      pending.some(
        (loan) =>
          loan.borrower === viewer.subject &&
          loan.startDate <= endDate &&
          startDate <= loan.endDate,
      )
    ) {
      throw new ConvexError(
        "You already have a pending request that overlaps those dates.",
      );
    }

    const loan = {
      toolId,
      toolName: tool.name,
      lender: tool.owner,
      borrower: viewer.subject,
      startDate,
      endDate,
      status: "pending",
    } as const;
    const id = await ctx.db.insert("loans", loan);
    await queueNotification(ctx, id, loan, tool.owner, "pending");
    return id;
  },
});

export const decide = mutation({
  args: {
    id: v.id("loans"),
    decision: v.union(v.literal("approved"), v.literal("declined")),
  },
  handler: async (ctx, { id, decision }) => {
    const viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(id);
    if (!loan) throw new ConvexError("Request not found.");
    requireOwner(viewer, loan.lender);
    if (loan.status === decision) return;
    if (loan.status !== "pending")
      throw new ConvexError("This request has already been decided.");

    if (decision === "approved") {
      const tool = await ctx.db.get(loan.toolId);
      if (!tool || tool.archived)
        throw new ConvexError("This listing is no longer active.");
      const today = utcToday();
      if (loan.endDate < today)
        throw new ConvexError("The requested dates have passed.");
      const approved = await loansForTool(ctx, loan.toolId, "approved");
      // The range read and this update run in one Convex transaction.
      if (
        conflictsWithApproval(approved, loan.startDate, loan.endDate, today)
      ) {
        throw new ConvexError("This request conflicts with an approved loan.");
      }
    }

    await ctx.db.patch(id, { status: decision });
    await queueNotification(ctx, id, loan, loan.borrower, decision);
  },
});

export const markReturned = mutation({
  args: { id: v.id("loans") },
  handler: async (ctx, { id }) => {
    const viewer = await requireViewer(ctx);
    const loan = await ctx.db.get(id);
    if (!loan) throw new ConvexError("Loan not found.");
    requireOwner(viewer, loan.lender);
    if (loan.status === "returned") return;
    if (loan.status !== "approved")
      throw new ConvexError("Only approved loans can be returned.");
    if (loan.startDate > utcToday())
      throw new ConvexError("This loan has not started.");
    await ctx.db.patch(id, { status: "returned" });
    await queueNotification(ctx, id, loan, loan.borrower, "returned");
  },
});

function loansForTool(
  ctx: MutationCtx,
  toolId: Id<"tools">,
  status: "approved" | "pending",
) {
  return ctx.db
    .query("loans")
    .withIndex("by_tool_and_status", (q) =>
      q.eq("toolId", toolId).eq("status", status),
    )
    .collect();
}

async function queueNotification(
  ctx: MutationCtx,
  loanId: Id<"loans">,
  {
    toolName,
    startDate,
    endDate,
  }: Pick<Doc<"loans">, "toolName" | "startDate" | "endDate">,
  recipient: string,
  status: Doc<"loans">["status"],
) {
  const id = await ctx.db.insert("notifications", {
    loanId,
    status,
    recipient,
    toolName,
    startDate,
    endDate,
    attempt: 0,
    delivery: "pending",
  });
  await ctx.scheduler.runAfter(0, internal.automation.deliver, { id });
}
