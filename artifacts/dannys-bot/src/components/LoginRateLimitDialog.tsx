import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  proxyDisplay: string;
  onCancel: () => void;
  onContinue: () => void;
}

export function LoginRateLimitDialog({ open, proxyDisplay, onCancel, onContinue }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            IP Login Rate Limit Warning
          </DialogTitle>
        </DialogHeader>
        <div className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{proxyDisplay}</span> has verified{" "}
          <span className="font-semibold text-red-600 dark:text-red-400">3 new accounts in the last 6 hours</span>.
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onContinue}>Continue Anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
