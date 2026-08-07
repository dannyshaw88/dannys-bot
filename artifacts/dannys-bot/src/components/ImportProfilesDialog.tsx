import { useState, useRef, useCallback } from "react";
import { Upload, FileText, CheckCircle2, XCircle, Loader2, AlertTriangle, X } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

interface ParsedProfile {
  accountLabel: string;
  username: string;
  password: string;
  email: string;
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPassword: string;
  userAgentEmbedded: string;
  userAgentApi: string;
  tags: string;
  dateOfBirth: string;
  notes: string;
  phoneNumber: string;
  twoFASecretKey: string;
  backupCodes: string;
  emailValidationUsername: string;
  emailValidationPassword: string;
  emailValidationPop3Server: string;
  emailValidationPort: string;
  accStatus: string;
  // Device fingerprint fields (exported by some Jarvee versions)
  deviceId: string;
  deviceUuid: string;
  phoneId: string;
  adid: string;
  // Session cookies from Jarvee's ApiCookies column
  apiCookies: string;
}

// Map Jarvee column headers (lowercased, # stripped) to our field names
const COLUMN_MAP: Record<string, keyof ParsedProfile> = {
  // ── Jarvee column names ───────────────────────────────────────────────────
  "name":                        "accountLabel",
  "acc status":                  "accStatus",
  "email/username":              "email",
  "password":                    "password",
  "proxy username":              "proxyUsername",
  "proxy password":              "proxyPassword",
  "tags":                        "tags",
  "date of birth(us format)":    "dateOfBirth",
  "eb user agent":               "userAgentEmbedded",
  "embedded browser user agent": "userAgentEmbedded",
  "browser user agent":          "userAgentEmbedded",
  "api user agent":              "userAgentApi",
  "mobile user agent":           "userAgentApi",
  "app user agent":              "userAgentApi",
  "device user agent":           "userAgentApi",
  "instagram user agent":        "userAgentApi",
  "username":                    "username",
  "notes":                       "notes",
  "phone number":                "phoneNumber",
  "2fa secret key":              "twoFASecretKey",
  "backup codes":                "backupCodes",
  "backup codes ":               "backupCodes",
  "email validation username":   "emailValidationUsername",
  "email validation pass":       "emailValidationPassword",
  "email validation pop3server": "emailValidationPop3Server",
  "email validation port":       "emailValidationPort",
  "device id":                   "deviceId",
  "android device id":           "deviceId",
  "android id":                  "deviceId",
  "deviceid":                    "deviceId",
  "uuid":                        "deviceUuid",
  "device uuid":                 "deviceUuid",
  "guid":                        "deviceUuid",
  "phone id":                    "phoneId",
  "phone uuid":                  "phoneId",
  "phoneid":                     "phoneId",
  "adid":                        "adid",
  "advertising id":              "adid",
  "google ad id":                "adid",
  "googleadid":                  "adid",
  "apicookies":                  "apiCookies",
  "api cookies":                 "apiCookies",
  "cookies":                     "apiCookies",
  "session cookies":             "apiCookies",
  // ── Equinox CSV export column names ──────────────────────────────────────
  "label":                       "accountLabel",
  "instagram username":          "username",
  "email":                       "email",
  "eb user agent (equinox)":     "userAgentEmbedded",
};

/**
 * Parse a delimited file (TSV or CSV) with full RFC-4180 quoted-cell support.
 * Delimiter is auto-detected from the first line: if tabs appear it uses tab,
 * otherwise commas. This handles both Jarvee TSV exports and Equinox CSV exports.
 */
function parseDSVRows(text: string): string[][] {
  // Strip BOM if present
  const clean = text.startsWith("\ufeff") ? text.slice(1) : text;

  // Detect delimiter from the first line
  const firstNewline = clean.indexOf("\n");
  const firstLine = firstNewline === -1 ? clean : clean.slice(0, firstNewline);
  const delim = firstLine.includes("\t") ? "\t" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;
  let i = 0;

  while (i < clean.length) {
    const ch = clean[i];

    if (inQuote) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
      continue;
    }

    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === delim) { row.push(cell); cell = ""; i++; continue; }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell);
      cell = "";
      if (row.some(c => c.trim())) rows.push(row);
      row = [];
      i++;
      continue;
    }

    cell += ch;
    i++;
  }

  // flush last row
  row.push(cell);
  if (row.some(c => c.trim())) rows.push(row);

  return rows;
}

/**
 * Parse a Jarvee binary profile file (.jarvee or any extension).
 *
 * Jarvee stores these as .NET BinaryFormatter objects XOR-encoded with 0xFF.
 * Detection: raw bytes[0..4] = FF FE FF FF FF (after XOR → 00 01 00 00 00 = BF header).
 *
 * Structure around each account block (after XOR-decode, scanning printable ASCII):
 *   [backup codes]  [smtp server]  [PASSWORD]  MassPlanner.Domain.Platform
 *   [proxy-pwd]  [proxy:port]  [display name]  [Jarvee ID]  [user agent]
 *   [proxy-username]  [secondary proxy]  [email]  [backup email]
 */
function parseJarveeBinaryFile(buffer: ArrayBuffer): ParsedProfile[] {
  const raw = new Uint8Array(buffer);

  // XOR-decode
  const dec = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) dec[i] = raw[i] ^ 0xFF;

  // Extract all printable ASCII runs ≥ 4 chars, record (offset, value)
  const strs: Array<{ off: number; val: string }> = [];
  let run = "";
  let runStart = 0;
  for (let i = 0; i <= dec.length; i++) {
    const b = dec[i];
    if (b !== undefined && b >= 0x20 && b <= 0x7E) {
      if (run.length === 0) runStart = i;
      run += String.fromCharCode(b);
    } else {
      if (run.length >= 4) strs.push({ off: runStart, val: run });
      run = "";
    }
  }

  // Valid Instagram username pattern (stored as Base64)
  const igRe = /^[a-zA-Z0-9_.]{5,30}$/;
  const b64Re = /^[A-Za-z0-9+/]{8,44}={0,2}$/;
  const proxyRe = /^[\d.a-zA-Z-]+:\d{4,5}$/;

  const results: ParsedProfile[] = [];
  const seen = new Set<string>();

  for (let si = 0; si < strs.length; si++) {
    const s = strs[si].val.trim();

    // Must be valid Base64 with correct padding
    if (!b64Re.test(s) || s.length % 4 !== 0) continue;

    let username = "";
    try {
      username = atob(s);
    } catch {
      continue;
    }
    if (!igRe.test(username) || !username.includes("_")) continue;
    if (seen.has(username)) continue;

    // Require an "Instagram_" profile-ID string nearby (confirms it's a real account block)
    const acctOff = strs[si].off;
    const nearby = strs.filter(x => x.off > acctOff && x.off < acctOff + 600);
    const hasProfileId = nearby.some(x => /^Instagram_\w+$/.test(x.val.trim()));
    if (!hasProfileId) continue;

    seen.add(username);

    // Scan a window of strings around this account block
    const window = strs.filter(x => x.off >= acctOff - 200 && x.off <= acctOff + 1600);

    let password = "";
    let proxyHost = "";
    let proxyPort = "";
    let proxyPassword = "";
    let proxyUsername = "";
    let userAgent = "";
    let email = "";
    let backupCodes = "";

    for (let j = 0; j < window.length; j++) {
      const v = window[j].val.trim();

      // Password: the string just before "MassPlanner.Domain.Platform"
      // Note: the Base64 exclusion must NOT be applied here — many passwords look
      // like valid Base64 (all alphanumeric, length multiple of 4). We only exclude
      // known system keywords and values that clearly aren't passwords.
      if (v === "MassPlanner.Domain.Platform") {
        for (let k = j - 1; k >= Math.max(0, j - 5); k--) {
          const cand = window[k].val.trim();
          if (
            cand.length >= 4 && cand.length <= 30 &&
            !/MassPlanner|System\.|value|smtp|http|@|PublicKey/.test(cand) &&
            !cand.endsWith("=") // skip Base64 blobs that have padding (passwords never end with =)
          ) {
            password = cand;
            break;
          }
        }
      }

      // User agent — .NET BinaryFormatter prepends a 1-byte string-length prefix
      // which is often a printable character (e.g. 'v' = 0x76 = 118), so the
      // extracted run looks like "vMozilla/5.0 ..." — match by contains, not startsWith.
      if (!userAgent && v.includes("Mozilla/5.0") && v.includes("AppleWebKit")) {
        // Strip the leading length-prefix byte if present
        userAgent = v.startsWith("Mozilla/") ? v : v.slice(1);
      }

      // Email (not an Instagram URL, not a type name)
      if (!email && v.includes("@") && v.includes(".") && v.length < 80 &&
          !v.includes("instagram.com") && !v.includes("PublicKey") &&
          !v.includes("mscorlib") && !v.includes("culture")) {
        email = v;
      }

      // Primary proxy host:port
      if (!proxyHost && proxyRe.test(v)) {
        const colon = v.lastIndexOf(":");
        proxyHost = v.slice(0, colon);
        proxyPort = v.slice(colon + 1);

        // Proxy password: the string just before the proxy host:port
        for (let k = j - 1; k >= Math.max(0, j - 4); k--) {
          const cand = window[k].val.trim();
          if (
            cand.length >= 4 && cand.length <= 30 &&
            !/MassPlanner|System\.|value__|@|http/.test(cand) &&
            !/^[A-Za-z0-9+/]{12,}={0,2}$/.test(cand)
          ) {
            proxyPassword = cand;
            break;
          }
        }

        // Proxy username: first all-lowercase-or-underscore string (≥8 chars) after the
        // proxy host:port. Jarvee stores the proxy username AFTER the user agent block
        // (i.e. further in the window), so we scan up to 20 entries ahead.
        // We allow underscores since real proxy usernames often look like "gdgxae_gcfhioo".
        for (let k = j + 1; k < Math.min(window.length, j + 20); k++) {
          const cand = window[k].val.trim();
          if (/^[a-z][a-z_]{7,}$/.test(cand)) {
            proxyUsername = cand;
            break;
          }
        }
      }

      // Backup codes: space-separated groups of uppercase + digits (OTP style)
      if (!backupCodes && /^[A-Z0-9]{4}( [A-Z0-9]{4}){3,}/.test(v)) {
        backupCodes = v.replace(/^'/, "");
      }
    }

    results.push({
      accountLabel: "",
      username,
      password,
      email,
      proxyHost,
      proxyPort,
      proxyUsername,
      proxyPassword,
      userAgentEmbedded: userAgent,
      userAgentApi: userAgent,
      tags: "",
      dateOfBirth: "",
      notes: "",
      phoneNumber: "",
      twoFASecretKey: "",
      backupCodes,
      emailValidationUsername: "",
      emailValidationPassword: "",
      emailValidationPop3Server: "",
      emailValidationPort: "",
      accStatus: "",
      deviceId: "",
      deviceUuid: "",
      phoneId: "",
      adid: "",
      apiCookies: "",
    });
  }

  return results;
}

function parseJarveeFile(text: string): ParsedProfile[] {
  const rows = parseDSVRows(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/^#/, ""));
  const results: ParsedProfile[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    const row: any = {
      accountLabel: "", username: "", password: "", email: "",
      proxyHost: "", proxyPort: "",
      proxyUsername: "", proxyPassword: "", userAgentEmbedded: "", userAgentApi: "",
      tags: "", dateOfBirth: "", notes: "", phoneNumber: "", twoFASecretKey: "",
      backupCodes: "", emailValidationUsername: "", emailValidationPassword: "",
      emailValidationPop3Server: "", emailValidationPort: "", accStatus: "",
      deviceId: "", deviceUuid: "", phoneId: "", adid: "", apiCookies: "",
    };

    headers.forEach((header, idx) => {
      const val = (cells[idx] || "").trim();

      if (header === "proxy-url/proxy-ip:port" || header === "proxy url/proxy ip:port") {
        const match = val.match(/^(.+):(\d+)$/);
        if (match) { row.proxyHost = match[1]; row.proxyPort = match[2]; }
        else if (val) row.proxyHost = val;
        return;
      }

      const field = COLUMN_MAP[header];
      // Only write if the value is non-empty, or if nothing has been set yet.
      // This prevents a later empty column (e.g. "Cookies" at col 23) from
      // overwriting a value already captured from an earlier column
      // (e.g. "ApiCookies" at col 19) when both map to the same field.
      if (field && (val || !row[field])) row[field] = val;
    });

    if (!row.username && row.email && !row.email.includes("@")) {
      row.username = row.email;
      row.email = "";
    }

    if (row.username || row.email) results.push(row as ParsedProfile);
  }

  return results;
}

interface ImportResult {
  success: boolean;
  username: string;
  action?: "created" | "updated";
  error?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportProfilesDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedProfile[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);

  const reset = () => {
    setParsed(null);
    setFileName("");
    setResults(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFile = useCallback((file: File) => {
    setFileName(file.name);
    setResults(null);
    const reader = new FileReader();
    reader.onload = async (e) => {
      const buf = e.target?.result as ArrayBuffer;
      try {
        const bytes = new Uint8Array(buf);

        // Detect Jarvee binary profile format:
        // Raw header = FF FE FF FF FF ... (XOR-decoded → 00 01 00 00 00 = .NET BinaryFormatter)
        // Distinguished from a normal UTF-16 LE BOM (FF FE followed by text) by bytes[2] = 0xFF.
        const isJarveeBinary =
          bytes[0] === 0xFF && bytes[1] === 0xFE &&
          bytes[2] === 0xFF && bytes[3] === 0xFF && bytes[4] === 0xFF;

        if (isJarveeBinary) {
          // Parse on the server using the proper BinaryFormatter parser (jarveeParser.ts).
          // Chunked base64 encode to avoid stack overflow on large files.
          let binary = "";
          const chunkSize = 8192;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
          }
          const fileBase64 = btoa(binary);
          try {
            const resp = await fetch("/api/profiles/parse-jarvee", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileBase64 }),
            });
            const data = await resp.json();
            if (!resp.ok) {
              toast({ title: "No profiles found", description: data.error ?? "Could not parse binary file", variant: "destructive" });
              setParsed(null);
            } else if (!data.profiles?.length) {
              toast({ title: "No profiles found", description: "The binary profile file contained no recognisable account blocks.", variant: "destructive" });
              setParsed(null);
            } else {
              setParsed(data.profiles);
            }
          } catch {
            toast({ title: "Parse error", description: "Could not connect to server.", variant: "destructive" });
          }
          return;
        }

        // Text-based Jarvee / Equinox CSV export — auto-detect encoding.
        // UTF-16 LE BOM = FF FE, UTF-16 BE BOM = FE FF, UTF-8 BOM = EF BB BF
        let encoding = "utf-8";
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = "utf-16le";
        else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = "utf-16be";

        const text = new TextDecoder(encoding).decode(buf);
        const profiles = parseJarveeFile(text);
        if (profiles.length === 0) {
          toast({ title: "No profiles found", description: "The file appears empty or has an unsupported format.", variant: "destructive" });
          setParsed(null);
        } else {
          setParsed(profiles);
        }
      } catch {
        toast({ title: "Parse error", description: "Could not read the file. Make sure it's a Jarvee export.", variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
  }, [toast]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleImport = async () => {
    if (!parsed || parsed.length === 0) return;
    setImporting(true);
    try {
      const res = await fetch("/api/profiles/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profiles: parsed }),
      });
      const data = await res.json();
      setResults(data.results);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      const ok = data.results.filter((r: ImportResult) => r.success).length;
      const fail = data.results.filter((r: ImportResult) => !r.success).length;
      const created = data.results.filter((r: ImportResult) => r.success && r.action === "created").length;
      const updated = data.results.filter((r: ImportResult) => r.success && r.action === "updated").length;
      localStorage.setItem("equinox_last_import", JSON.stringify({
        ts: Date.now(), fileName, created, updated, failed: fail, total: ok + fail,
      }));
      const parts = [];
      if (created) parts.push(`${created} created`);
      if (updated) parts.push(`${updated} updated`);
      if (fail) parts.push(`${fail} failed`);
      toast({
        title: "Import complete",
        description: parts.join(", ") || `${ok} processed`,
        variant: fail > 0 ? "destructive" : "default",
      });
    } catch {
      toast({ title: "Import failed", description: "Server error during import.", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const handleClose = () => {
    if (!importing) { reset(); onOpenChange(false); }
  };

  const successCount = results?.filter(r => r.success).length ?? 0;
  const failCount = results?.filter(r => !r.success).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" /> Import Profiles
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            Import accounts from a Jarvee export — binary profile files or .txt/.csv tab-separated exports.
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4 py-2">
          {/* Drop zone */}
          {!parsed && !results && (
            <div
              className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
                isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              data-testid="dropzone-import"
            >
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-foreground">Drop your Jarvee export here</p>
                <p className="text-sm text-muted-foreground mt-1">Binary profile files, .txt, or .csv — all supported</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="*"
                className="hidden"
                onChange={onFileChange}
                data-testid="input-import-file"
              />
            </div>
          )}

          {/* Preview */}
          {parsed && !results && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground">{fileName}</span>
                  <Badge variant="secondary">{parsed.length} profile{parsed.length !== 1 ? "s" : ""} found</Badge>
                </div>
                <button onClick={reset} className="text-muted-foreground hover:text-foreground transition-colors" data-testid="button-clear-import">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="border border-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto max-h-60">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">#</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Username</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Proxy</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">API UA</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Device IDs</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">Cookies</th>
                        <th className="text-left px-3 py-2 font-bold text-muted-foreground">2FA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.map((p, i) => {
                        const hasExplicitDeviceIds = !!(p.deviceId || p.deviceUuid || p.phoneId || p.adid);
                        const canDeriveDeviceIds = !!p.userAgentApi; // server derives from UA if no explicit IDs
                        return (
                          <tr key={i} className="border-t border-border hover:bg-muted/20">
                            <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                            <td className="px-3 py-2 font-mono font-semibold">{p.username || <span className="text-destructive"> </span>}</td>
                            <td className="px-3 py-2 font-mono text-muted-foreground">{p.proxyHost ? `${p.proxyHost}:${p.proxyPort}` : " "}</td>
                            <td className="px-3 py-2">
                              {p.userAgentApi
                                ? <span className="text-green-700 font-mono truncate block max-w-[140px]" title={p.userAgentApi}>✓ {p.userAgentApi.slice(0, 22)}…</span>
                                : <span className="text-destructive">✗ missing</span>}
                            </td>
                            <td className="px-3 py-2">
                              {hasExplicitDeviceIds
                                ? <Badge variant="outline" className="text-[10px] text-green-700 border-green-300">✓ from file</Badge>
                                : canDeriveDeviceIds
                                  ? <Badge variant="outline" className="text-[10px] text-blue-600 border-blue-300">✓ derived</Badge>
                                  : <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">✗ none</Badge>}
                            </td>
                            <td className="px-3 py-2">
                              {p.apiCookies
                                ? <Badge variant="outline" className="text-[10px] text-green-700 border-green-300">✓ yes</Badge>
                                : <span className="text-muted-foreground"> </span>}
                            </td>
                            <td className="px-3 py-2">{p.twoFASecretKey ? <Badge variant="outline" className="text-[10px]">Yes</Badge> : " "}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsed.some(p => !p.username) && (
                <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  Some rows have no username and may be skipped during import.
                </div>
              )}

              {parsed.some(p => !p.userAgentApi && !p.deviceId && !p.deviceUuid) && (
                <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    <strong>Some accounts have no API User Agent</strong> device IDs cannot be derived without it.
                    Instagram may require email verification on first login for those accounts.
                    Include the <em>API User Agent</em> column in your Jarvee export, or the <em>UUID / Device ID / Phone ID / ADID</em> columns directly.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Results */}
          {results && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                {results.filter(r => r.success && r.action === "created").length > 0 && (
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-4 h-4" /> {results.filter(r => r.success && r.action === "created").length} created
                  </div>
                )}
                {results.filter(r => r.success && r.action === "updated").length > 0 && (
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                    <CheckCircle2 className="w-4 h-4" /> {results.filter(r => r.success && r.action === "updated").length} updated
                  </div>
                )}
                {failCount > 0 && (
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
                    <XCircle className="w-4 h-4" /> {failCount} failed
                  </div>
                )}
              </div>
              {failCount > 0 && (
                <div className="border border-border rounded-xl overflow-hidden">
                  <div className="overflow-auto max-h-48">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-2 font-bold text-muted-foreground">Username</th>
                          <th className="text-left px-3 py-2 font-bold text-muted-foreground">Status</th>
                          <th className="text-left px-3 py-2 font-bold text-muted-foreground">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.filter(r => !r.success).map((r, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="px-3 py-2 font-mono">{r.username}</td>
                            <td className="px-3 py-2"><Badge variant="destructive" className="text-[10px]">Failed</Badge></td>
                            <td className="px-3 py-2 text-muted-foreground">{r.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose} disabled={importing}>
            {results ? "Close" : "Cancel"}
          </Button>
          {parsed && !results && (
            <Button onClick={handleImport} disabled={importing || parsed.length === 0} data-testid="button-confirm-import">
              {importing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Importing…</> : `Import ${parsed.length} Profile${parsed.length !== 1 ? "s" : ""}`}
            </Button>
          )}
          {results && (
            <Button onClick={reset} variant="outline">
              Import Another File
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
