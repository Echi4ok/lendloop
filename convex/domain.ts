import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export async function requireViewer(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Sign in to continue.");
  const admins = (process.env.LENDLOOP_ADMIN_SUBJECTS ?? "")
    .split(",")
    .map((subject) => subject.trim());
  return {
    subject: identity.subject,
    isAdmin: admins.includes(identity.subject),
  };
}

export function requireOwner(
  viewer: Awaited<ReturnType<typeof requireViewer>>,
  owner: string,
) {
  if (viewer.subject !== owner)
    throw new ConvexError("Only the owner can do that.");
}

export const listingFields = {
  name: v.string(),
  category: v.string(),
  condition: v.string(),
  description: v.string(),
};

export function cleanListing(
  fields: Pick<Doc<"tools">, keyof typeof listingFields>,
) {
  return {
    name: cleanText(fields.name, "Name", 80),
    category: cleanText(fields.category, "Category", 40),
    condition: cleanText(fields.condition, "Condition", 80),
    description: cleanText(fields.description, "Description", 600),
  };
}

function cleanText(value: string, label: string, limit: number) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > limit) {
    throw new ConvexError(
      `${label} must contain between 1 and ${limit} characters.`,
    );
  }
  return trimmed;
}

export function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

export function isDate(value: string) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

export function availability(approved: Doc<"loans">[], today: string) {
  if (approved.some((loan) => loan.startDate <= today))
    return "loaned" as const;
  return approved.length ? ("reserved" as const) : ("available" as const);
}

export function conflictsWithApproval(
  approved: Doc<"loans">[],
  startDate: string,
  endDate: string,
  today: string,
) {
  return approved.some(
    (loan) =>
      loan.endDate < today ||
      (loan.startDate <= endDate && startDate <= loan.endDate),
  );
}
