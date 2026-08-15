import { ImapFlow } from "imapflow";

/**
 * Polls an IMAP inbox for a 6-digit Instagram verification code.
 * Returns the code string, or null if not found within the timeout.
 */
export async function fetchInstagramCodeFromImap(opts: {
  host: string;
  port: number;
  user: string;
  pass: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const { host, port, user, pass, timeoutMs = 90_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 6_000;

  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host,
      port,
      secure: port !== 143,
      auth: { user, pass },
      logger: false,
      tls: { rejectUnauthorized: false },
    });

    try {
      await client.connect();
      await client.mailboxOpen("INBOX");

      // Search emails received in the last 15 minutes from Instagram senders
      const since = new Date(Date.now() - 15 * 60 * 1000);
      const messages = await client.search({ since, from: "instagram" });

      for (const seq of [...messages].reverse()) {
        const msg = await client.fetchOne(String(seq), { source: true });
        if (!msg?.source) continue;
        const body = msg.source.toString("utf-8");
        // Extract standalone 6-digit code — Instagram uses formats like "123456" or "Your code is 123 456"
        const match = body.match(/(?<!\d)(\d{6})(?!\d)/) ?? body.match(/(\d{3})\s(\d{3})/).map((m, i) => i === 0 ? m?.replace(/\s/g, "") : m);
        const code = Array.isArray(match) ? (match[1] + (match[2] ?? "")).replace(/\s/g, "") : null;
        if (code && /^\d{6}$/.test(code)) {
          await client.logout();
          return code;
        }
      }

      await client.logout();
    } catch {
      // ignore connection/search errors and retry
    }

    if (Date.now() + pollInterval < deadline) {
      await new Promise<void>(r => setTimeout(r, pollInterval));
    } else {
      break;
    }
  }

  return null;
}
