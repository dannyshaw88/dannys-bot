import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  addVisitedAddress, BROWSER_ADDRESS_HISTORY_KEY, readVisitedAddresses,
} from "@/lib/browserAddressHistory";

export function useBrowserAddressHistory(enabled: boolean) {
  const [addresses, setAddresses] = useState<string[]>(() => {
    if (!enabled) return [];
    try {
      return readVisitedAddresses(JSON.parse(localStorage.getItem(BROWSER_ADDRESS_HISTORY_KEY) || "[]"));
    } catch (error) {
      console.warn("[Browser history] Could not read saved addresses", error);
      return [];
    }
  });
  useEffect(() => {
    if (!enabled) return;
    try {
      localStorage.setItem(BROWSER_ADDRESS_HISTORY_KEY, JSON.stringify(addresses));
    } catch (error) {
      console.warn("[Browser history] Could not save visited addresses", error);
    }
  }, [addresses, enabled]);
  const recordVisitedAddress = useCallback((url: unknown) => {
    if (enabled) setAddresses(previous => addVisitedAddress(previous, url));
  }, [enabled]);
  return { addresses, recordVisitedAddress };
}

export function BrowserAddressHistory({ addresses, disabled, onSelect }: {
  addresses: string[];
  disabled: boolean;
  onSelect: (address: string) => void;
}) {
  return (
    <div className="absolute right-0 top-0 h-8 w-8">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon"
          className="h-8 w-8 rounded-l-none"
          disabled={disabled} title="Previously visited addresses" aria-label="Previously visited addresses">
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-[min(36rem,calc(100vw-2rem))] overflow-y-auto">
        <DropdownMenuLabel>Previously visited addresses</DropdownMenuLabel>
        {addresses.length === 0
          ? <DropdownMenuItem disabled>No visited addresses yet</DropdownMenuItem>
          : addresses.map(address => (
            <DropdownMenuItem key={address} onSelect={() => onSelect(address)} title={address}>
              <span className="truncate">{address}</span>
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  );
}
