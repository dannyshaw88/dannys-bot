import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const NUMBER_INDEX_DIR = process.env.EQUINOX_DATA_DIR
  ? path.join(process.env.EQUINOX_DATA_DIR, "whatsapp-sent-number-index")
  : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "whatsapp-sent-number-index");

function indexPath(serial: string): string {
  const deviceKey = createHash("sha256").update(serial).digest("hex").slice(0, 20);
  return path.join(NUMBER_INDEX_DIR, `${deviceKey}.txt`);
}

export function normalizeWhatsAppPhoneNumber(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export function loadWhatsAppSentNumberIndex(serial: string): Set<string> {
  const filePath = indexPath(serial);
  try {
    return new Set(
      fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .map(line => normalizeWhatsAppPhoneNumber(line))
        .filter((number): number is string => Boolean(number)),
    );
  } catch (error: any) {
    if (error?.code === "ENOENT") return new Set();
    throw new Error(`Could not read WhatsApp sent-number index: ${error?.message ?? error}`);
  }
}

/** Reserve before tapping Send so a crash during the send cannot cause a repeat. */
export function reserveWhatsAppPhoneNumber(serial: string, number: string): void {
  const normalized = normalizeWhatsAppPhoneNumber(number);
  if (!normalized) throw new Error("WhatsApp recipient phone number is not valid");
  if (loadWhatsAppSentNumberIndex(serial).has(normalized)) {
    throw new Error("WhatsApp recipient number is already in the sent-number index");
  }
  const filePath = indexPath(serial);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${normalized}${os.EOL}`, { encoding: "utf8", flag: "a" });
  } catch (error: any) {
    throw new Error(`Could not save WhatsApp recipient number before sending: ${error?.message ?? error}`);
  }
}

export function parseAndroidPhonebook(output: string): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const line of output.split(/\r?\n/)) {
    const displayName = line.match(/(?:^|[,\s])display_name=(.*?)(?=, [A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1]?.trim();
    const normalizedNumber = (
      line.match(/(?:^|[,\s])normalized_number=([^,]*?)(?=, [A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1] ??
      line.match(/(?:^|[,\s])data4=([^,]*?)(?=, [A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1]
    )?.trim();
    const rawNumber = line.match(/(?:^|[,\s])data1=([^,]*?)(?=, [A-Za-z_][A-Za-z0-9_]*=|$)/)?.[1]?.trim();
    const number = normalizeWhatsAppPhoneNumber(normalizedNumber || rawNumber || "");
    const nameKey = displayName?.toLocaleLowerCase().replace(/\s+/g, " ");
    if (!nameKey || !number) continue;
    const numbers = byName.get(nameKey) ?? new Set<string>();
    numbers.add(number);
    byName.set(nameKey, numbers);
  }
  return byName;
}
