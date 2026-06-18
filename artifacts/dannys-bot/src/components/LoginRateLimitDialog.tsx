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
          <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            IP Login Rate Limit Warning
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>
            <span className="font-semibold">{proxyDisplay}</span> has already been used to verify{" "}
            <span className="font-semibold text-amber-600 dark:text-amber-400">3 new accounts today</span>.
          </p>
          <p className="text-muted-foreground">
            Instagram allows roughly{" "}
            <span className="font-semibold text-foreground">3 new account logins per IP per 24 hours</span>.
            Adding a 4th new account on this IP today may increase the risk of login flags.
            Accounts already running on this proxy for 24+ hours are not affected.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onContinue}>Continue Anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
