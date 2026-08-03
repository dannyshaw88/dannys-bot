import { createContext, useContext, useState, ReactNode } from "react";

const SetSlotContext = createContext<(node: ReactNode) => void>(() => {});
const SlotContext = createContext<ReactNode>(null);

export function SidebarSlotProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<ReactNode>(null);
  return (
    <SetSlotContext.Provider value={setSlot}>
      <SlotContext.Provider value={slot}>
        {children}
      </SlotContext.Provider>
    </SetSlotContext.Provider>
  );
}

export function useSidebarSetSlot() {
  return useContext(SetSlotContext);
}

export function useSidebarSlot() {
  return useContext(SlotContext);
}
