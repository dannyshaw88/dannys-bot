import { createContext, useContext, useRef, useState, ReactNode } from "react";

interface NavigationHistoryContextValue {
  canBack: boolean;
  canForward: boolean;
  pushLocation: (loc: string) => void;
  back: () => string | null;
  forward: () => string | null;
}

const NavigationHistoryContext = createContext<NavigationHistoryContextValue>({
  canBack: false,
  canForward: false,
  pushLocation: () => {},
  back: () => null,
  forward: () => null,
});

export function NavigationHistoryProvider({ children }: { children: ReactNode }) {
  const stack = useRef<string[]>([]);
  const index = useRef(-1);
  const isNavigating = useRef(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  function pushLocation(loc: string) {
    if (!loc || loc === "/") return;

    if (isNavigating.current) {
      isNavigating.current = false;
      setCanBack(index.current > 0);
      setCanForward(index.current < stack.current.length - 1);
      return;
    }

    if (stack.current[index.current] === loc) return;

    const newStack = stack.current.slice(0, index.current + 1);
    newStack.push(loc);
    stack.current = newStack;
    index.current = newStack.length - 1;
    setCanBack(index.current > 0);
    setCanForward(false);
  }

  function back(): string | null {
    if (index.current <= 0) return null;
    index.current -= 1;
    isNavigating.current = true;
    return stack.current[index.current];
  }

  function forward(): string | null {
    if (index.current >= stack.current.length - 1) return null;
    index.current += 1;
    isNavigating.current = true;
    return stack.current[index.current];
  }

  return (
    <NavigationHistoryContext.Provider value={{ canBack, canForward, pushLocation, back, forward }}>
      {children}
    </NavigationHistoryContext.Provider>
  );
}

export function useNavigationHistory() {
  return useContext(NavigationHistoryContext);
}
