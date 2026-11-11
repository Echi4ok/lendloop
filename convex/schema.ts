import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const loanStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("returned"),
);

export default defineSchema({
  tools: defineTable({
    owner: v.string(),
    name: v.string(),
    category: v.string(),
    condition: v.string(),
    description: v.string(),
    archived: v.boolean(),
  })
    .index("by_owner", ["owner"])
    .index("by_archived", ["archived"]),
  loans: defineTable({
    toolId: v.id("tools"),
    toolName: v.string(),
    lender: v.string(),
    borrower: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    status: loanStatus,
    reminderSentAt: v.optional(v.number()),
  })
    .index("by_tool_and_status", ["toolId", "status"])
    .index("by_lender", ["lender"])
    .index("by_borrower", ["borrower"])
    .index("by_status_and_end_date", ["status", "endDate"]),
  trustedLenders: defineTable({ subject: v.string() }).index("by_subject", [
    "subject",
  ]),
  reminders: defineTable({
    loanId: v.id("loans"),
    reminderDate: v.string(),
  }).index("by_loan_and_date", ["loanId", "reminderDate"]),
  notifications: defineTable({
    loanId: v.id("loans"),
    status: loanStatus,
    recipient: v.string(),
    toolName: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    attempt: v.number(),
    delivery: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
  }),
});
