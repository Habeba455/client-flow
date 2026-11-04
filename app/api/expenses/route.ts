import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/current-user";
import { db } from "@/lib/db";
import {
  ApiInputError,
  errorResponse,
  readDateOnly,
  readId,
  readJsonObject,
  readOptionalText,
} from "@/lib/api-validation";
import { assertProjectOwned } from "@/lib/workspace/project-links";

const DUPLICATE_WINDOW = "10 minutes";

function parseAmount(value: unknown): number {
  const amount = typeof value === "string" ? Number(value.replace(/,/g, "")) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new ApiInputError("Amount must be a positive number.");
  }
  return Math.round(amount * 100) / 100;
}

function parseCurrency(value: unknown): string {
  if (value === undefined || value === null || value === "") return "USD";
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new ApiInputError("Currency must be a 3-letter code such as USD.");
  }
  return value.trim().toUpperCase();
}

/** Saved expenses for the signed-in user. Optional ?projectId= filter. */
export async function GET(req: NextRequest) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

    const projectId = readId(req.nextUrl.searchParams.get("projectId"), "Project") ?? null;
    const rows = await db.query<{
      id: string;
      description: string | null;
      category: string | null;
      amount: string;
      currency: string | null;
      entry_date: string;
      project_id: string | null;
      created_at: string;
    }>(
      `SELECT id, description, category, amount, currency, entry_date, project_id, created_at
       FROM pnl_entries
       WHERE user_id = $1 AND type = 'expense' AND ($2::text IS NULL OR project_id = $2)
       ORDER BY entry_date DESC, created_at DESC
       LIMIT 200`,
      [current.user.id, projectId]
    );

    return NextResponse.json({
      success: true,
      expenses: rows.map((row) => ({ ...row, amount: Number(row.amount) })),
    });
  } catch (error) {
    return errorResponse(error, "expenses.list");
  }
}

export async function POST(req: NextRequest) {
  try {
    const current = await getCurrentUser();
    if (!current) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

    const data = readJsonObject(await req.json().catch(() => null));
    const description =
      readOptionalText(data.description, "Description", 300) ??
      readOptionalText((data.vendor as { name?: unknown } | undefined)?.name, "Vendor", 300) ??
      "Receipt expense";
    const category = readOptionalText(data.category ?? data.category_suggestion, "Category", 100) ?? null;
    const amount = parseAmount(data.amount ?? data.total);
    const currency = parseCurrency(data.currency);
    const entryDate =
      readDateOnly(data.entryDate ?? (data.receipt as { date?: unknown } | undefined)?.date, "Date") ??
      new Date().toISOString().slice(0, 10);
    const projectId = readId(data.project_id ?? data.projectId, "Project") ?? null;
    if (projectId) await assertProjectOwned(current.user.id, projectId);

    // Duplicate guard: the same vendor, amount, date and project saved again within a few minutes is rejected
    // unless the caller explicitly confirms (e.g. two genuinely identical purchases).
    if (data.confirmDuplicate !== true) {
      const duplicate = await db.queryOne<{ id: string }>(
        `SELECT id FROM pnl_entries
         WHERE user_id = $1 AND type = 'expense' AND description = $2 AND amount = $3
           AND entry_date = $4 AND project_id IS NOT DISTINCT FROM $5
           AND created_at > NOW() - INTERVAL '${DUPLICATE_WINDOW}'
         LIMIT 1`,
        [current.user.id, description, amount, entryDate, projectId]
      );
      if (duplicate) {
        return NextResponse.json(
          {
            success: false,
            error: "An identical expense was saved a moment ago. Confirm if this is a separate purchase.",
            duplicateId: duplicate.id,
          },
          { status: 409 }
        );
      }
    }

    const expense = await db.queryOne(
      `INSERT INTO pnl_entries (id, user_id, type, description, category, amount, currency, entry_date, project_id, created_at)
       VALUES ($1, $2, 'expense', $3, $4, $5, $6, $7, $8, NOW())
       RETURNING id, description, category, amount, currency, entry_date, project_id, created_at`,
      [randomUUID(), current.user.id, description, category, amount, currency, entryDate, projectId]
    );

    return NextResponse.json({ success: true, expense }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "expenses.create");
  }
}
