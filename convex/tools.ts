import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import {
  availability,
  cleanListing,
  listingFields,
  requireOwner,
  requireViewer,
  utcToday,
} from "./domain";

export const publicTools = query({
  args: {},
  handler: async (ctx) => {
    const tools = await activeListings(ctx);
    const approvedIds = new Set(
      (await approvedLoans(ctx)).map((loan) => loan.toolId),
    );
    return tools
      .filter((tool) => !approvedIds.has(tool._id))
      .map(({ _id, name, category }) => ({ _id, name, category }));
  },
});

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const today = utcToday();
    const [listings, approved, trustedLenders, myRequests, incoming, allLoans] =
      await Promise.all([
        activeListings(ctx),
        approvedLoans(ctx),
        ctx.db.query("trustedLenders").collect(),
        ctx.db
          .query("loans")
          .withIndex("by_borrower", (q) => q.eq("borrower", viewer.subject))
          .order("desc")
          .collect(),
        ctx.db
          .query("loans")
          .withIndex("by_lender", (q) => q.eq("lender", viewer.subject))
          .order("desc")
          .collect(),
        viewer.isAdmin ? ctx.db.query("loans").order("desc").collect() : [],
      ]);
    const trustedSubjects = new Set(
      trustedLenders.map((lender) => lender.subject),
    );
    const approvedByTool = new Map<Doc<"loans">["toolId"], Doc<"loans">[]>();
    for (const loan of approved) {
      const matches = approvedByTool.get(loan.toolId) ?? [];
      matches.push(loan);
      approvedByTool.set(loan.toolId, matches);
    }
    const tools = listings.map(
      ({ _id, name, category, condition, description, owner }) => ({
        _id,
        name,
        category,
        condition,
        description,
        availability: availability(approvedByTool.get(_id) ?? [], today),
        isMine: owner === viewer.subject,
        isTrusted: trustedSubjects.has(owner),
      }),
    );
    return {
      viewer,
      tools,
      myListings: tools.filter((tool) => tool.isMine),
      myRequests: myRequests.map(projectLoan),
      incoming: incoming.map(projectLoan),
      allLoans: allLoans.map(projectLoan),
    };
  },
});

export const create = mutation({
  args: listingFields,
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    return ctx.db.insert("tools", {
      ...cleanListing(args),
      owner: viewer.subject,
      archived: false,
    });
  },
});

export const update = mutation({
  args: { id: v.id("tools"), ...listingFields },
  handler: async (ctx, { id, ...fields }) => {
    const viewer = await requireViewer(ctx);
    const tool = await ctx.db.get(id);
    if (!tool || tool.archived) throw new ConvexError("Listing not found.");
    requireOwner(viewer, tool.owner);
    await ctx.db.patch(id, cleanListing(fields));
  },
});

export const remove = mutation({
  args: { id: v.id("tools") },
  handler: async (ctx, { id }) => {
    const viewer = await requireViewer(ctx);
    const tool = await ctx.db.get(id);
    if (!tool) throw new ConvexError("Listing not found.");
    if (!viewer.isAdmin) requireOwner(viewer, tool.owner);
    // Keep the loan and audit history accessible after a listing is removed.
    if (!tool.archived) await ctx.db.patch(id, { archived: true });
  },
});

export const trustLender = mutation({
  args: { id: v.id("tools") },
  handler: async (ctx, { id }) => {
    const viewer = await requireViewer(ctx);
    if (!viewer.isAdmin) throw new ConvexError("Admin access required.");
    const tool = await ctx.db.get(id);
    if (!tool || tool.archived) throw new ConvexError("Listing not found.");
    const trusted = await ctx.db
      .query("trustedLenders")
      .withIndex("by_subject", (q) => q.eq("subject", tool.owner))
      .unique();
    if (!trusted)
      await ctx.db.insert("trustedLenders", { subject: tool.owner });
  },
});

function activeListings(ctx: QueryCtx) {
  return ctx.db
    .query("tools")
    .withIndex("by_archived", (q) => q.eq("archived", false))
    .order("desc")
    .collect();
}

function approvedLoans(ctx: QueryCtx) {
  return ctx.db
    .query("loans")
    .withIndex("by_status_and_end_date", (q) => q.eq("status", "approved"))
    .collect();
}

function projectLoan({
  _id,
  toolName,
  startDate,
  endDate,
  status,
  reminderSentAt,
}: Doc<"loans">) {
  return { _id, toolName, startDate, endDate, status, reminderSentAt };
}
