import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, Clipboard, FileSearch, FileText, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

function printableStrings(bytes: Uint8Array, minLength = 4) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const results: string[] = [];
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const printable = i < bytes.length && (bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13 || (bytes[i] >= 32 && bytes[i] <= 126));
    if (printable && start < 0) start = i;
    if ((!printable || i === bytes.length) && start >= 0) {
      const value = decoder.decode(bytes.slice(start, i)).trim();
      if (value.length >= minLength) results.push(value);
      start = -1;
    }
  }
  return results;
}

export default function JarveeBinaryViewerPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [strings, setStrings] = useState<string[]>([]);
  const [error, setError] = useState("");

  const readFile = async (file?: File) => {
    if (!file) return;
    setError("");
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\u0000/g, "");
      const extracted = printableStrings(bytes);
      setText(decoded.trim() || "(No directly decodable text was found.)");
      setStrings(extracted);
    } catch {
      setText("");
      setStrings([]);
      setError("This file could not be read in the browser.");
    }
  };

  const copyText = async () => {
    const output = [text, strings.length ? "\n--- Printable strings extracted from binary ---\n" + strings.join("\n") : ""].join("");
    await navigator.clipboard.writeText(output);
    toast({ title: "Text copied to clipboard" });
  };

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto pb-10">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-xl bg-primary/10 text-primary"><FileSearch className="w-5 h-5" /></div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Import Jarvee Binary File</h1>
            <p className="text-sm text-muted-foreground mt-1">Temporary reader — inspect a Jarvee profile file without importing accounts.</p>
          </div>
        </div>

        <div className="desktop-card p-6 mb-5">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary"><Upload className="w-4 h-4" /></div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold">Choose a Jarvee binary file</h2>
              <p className="text-xs text-muted-foreground mt-1">The file is read locally and converted to text. Nothing is saved, uploaded, or added to Accounts.</p>
              <input ref={inputRef} type="file" accept=".bin,.dat,.jarvee,application/octet-stream" className="hidden" onChange={e => void readFile(e.target.files?.[0])} />
              <div className="flex items-center gap-3 mt-4">
                <Button onClick={() => inputRef.current?.click()}><Upload className="w-4 h-4 mr-2" />Browse</Button>
                {fileName && <span className="text-sm text-foreground truncate">{fileName}</span>}
              </div>
            </div>
          </div>
          {error && <div className="mt-4 flex items-center gap-2 text-sm text-destructive"><AlertCircle className="w-4 h-4" />{error}</div>}
          {fileName && !error && <div className="mt-4 flex items-center gap-2 text-xs text-emerald-600"><CheckCircle2 className="w-4 h-4" />Read successfully — display only; no account import occurred.</div>}
        </div>

        <div className="desktop-card overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2"><FileText className="w-4 h-4 text-primary" /><h2 className="text-sm font-semibold">Converted text</h2></div>
            <Button variant="outline" size="sm" disabled={!text && !strings.length} onClick={() => void copyText()}><Clipboard className="w-3.5 h-3.5 mr-1.5" />Copy text</Button>
          </div>
          {!text && !strings.length ? (
            <div className="py-20 text-center text-sm text-muted-foreground">Browse for a Jarvee binary file to view its contents here.</div>
          ) : (
            <div className="p-5 space-y-5">
              <pre className="min-h-[280px] max-h-[620px] overflow-auto rounded-lg bg-slate-950 text-slate-100 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words">{text}</pre>
              {strings.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Printable strings found in binary ({strings.length})</h3>
                  <pre className="max-h-[420px] overflow-auto rounded-lg bg-muted/50 p-4 text-xs leading-relaxed whitespace-pre-wrap break-words">{strings.join("\n")}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}