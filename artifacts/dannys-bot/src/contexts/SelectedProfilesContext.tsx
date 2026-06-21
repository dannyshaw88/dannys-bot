import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface SelectedProfilesContextValue {
  selectedProfileIds: number[];
  setSelectedProfileIds: (ids: number[] | ((prev: number[]) => number[])) => void;
  toggleProfileId: (id: number) => void;
  clearSelectedProfileIds: () => void;
}

const SelectedProfilesContext = createContext<SelectedProfilesContextValue>({
  selectedProfileIds: [],
  setSelectedProfileIds: () => {},
  toggleProfileId: () => {},
  clearSelectedProfileIds: () => {},
});

export function SelectedProfilesProvider({ children }: { children: ReactNode }) {
  const [selectedProfileIds, setSelectedProfileIds] = useState<number[]>([]);

  const toggleProfileId = useCallback((id: number) => {
    setSelectedProfileIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  const clearSelectedProfileIds = useCallback(() => {
    setSelectedProfileIds([]);
  }, []);

  return (
    <SelectedProfilesContext.Provider value={{ selectedProfileIds, setSelectedProfileIds, toggleProfileId, clearSelectedProfileIds }}>
      {children}
    </SelectedProfilesContext.Provider>
  );
}

export function useSelectedProfiles() {
  return useContext(SelectedProfilesContext);
}
