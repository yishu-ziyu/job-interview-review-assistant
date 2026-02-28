import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_COMPANY_ALIAS_DICT,
  normalizeCompanyAliasDictionary,
  type CompanyAliasEntry,
} from "@/lib/browser-capture";

type CompanyAliasStore = {
  entries: CompanyAliasEntry[];
};

const STORE_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(STORE_DIR, "company-aliases.json");

async function ensureStore(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    const initial: CompanyAliasStore = {
      entries: normalizeCompanyAliasDictionary(DEFAULT_COMPANY_ALIAS_DICT),
    };
    await fs.writeFile(STORE_PATH, JSON.stringify(initial, null, 2), "utf-8");
  }
}

async function readStore(): Promise<CompanyAliasStore> {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, "utf-8");
  try {
    const parsed = JSON.parse(raw) as CompanyAliasStore;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { entries: normalizeCompanyAliasDictionary(DEFAULT_COMPANY_ALIAS_DICT) };
    }
    return {
      entries: normalizeCompanyAliasDictionary(parsed.entries),
    };
  } catch {
    return { entries: normalizeCompanyAliasDictionary(DEFAULT_COMPANY_ALIAS_DICT) };
  }
}

async function writeStore(store: CompanyAliasStore): Promise<void> {
  await ensureStore();
  const tempPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tempPath, STORE_PATH);
}

export async function listCompanyAliasEntries(): Promise<CompanyAliasEntry[]> {
  const store = await readStore();
  return store.entries;
}

export async function saveCompanyAliasEntries(
  entries: CompanyAliasEntry[],
): Promise<CompanyAliasEntry[]> {
  const normalized = normalizeCompanyAliasDictionary(entries);
  await writeStore({ entries: normalized });
  return normalized;
}

export async function resetCompanyAliasEntries(): Promise<CompanyAliasEntry[]> {
  const normalized = normalizeCompanyAliasDictionary(DEFAULT_COMPANY_ALIAS_DICT);
  await writeStore({ entries: normalized });
  return normalized;
}
