import { NextResponse } from "next/server";
import {
  listCompanyAliasEntries,
  resetCompanyAliasEntries,
  saveCompanyAliasEntries,
} from "@/lib/company-alias-store";
import type { CompanyAliasEntry } from "@/lib/browser-capture";

export const runtime = "nodejs";

type UpdateRequest = {
  entries?: CompanyAliasEntry[];
};

type ResetRequest = {
  action?: string;
};

export async function GET() {
  try {
    const entries = await listCompanyAliasEntries();
    return NextResponse.json({ entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as UpdateRequest;
    if (!Array.isArray(body.entries)) {
      return NextResponse.json(
        { error: "entries 必须是数组。" },
        { status: 400 },
      );
    }
    const entries = await saveCompanyAliasEntries(body.entries);
    return NextResponse.json({ entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ResetRequest;
    if (body.action !== "reset") {
      return NextResponse.json(
        { error: "仅支持 action=reset。" },
        { status: 400 },
      );
    }
    const entries = await resetCompanyAliasEntries();
    return NextResponse.json({ entries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
