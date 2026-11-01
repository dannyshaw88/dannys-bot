import React from "react";

export type AppCloseGestureSwipe = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  durationMs: number;
};

type AppCloseGestureRecorderValue = {
  serial: string | null;
  recording: boolean;
  swipes: AppCloseGestureSwipe[];
  sessionId: number;
  start: (serial: string) => void;
  stop: () => void;
  record: (serial: string, swipe: AppCloseGestureSwipe) => void;
};

const AppCloseGestureRecorderContext =
  React.createContext<AppCloseGestureRecorderValue | null>(null);

export function useAppCloseGestureRecorder() {
  return React.useContext(AppCloseGestureRecorderContext);
}

export function AppCloseGestureRecorderProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [capture, setCapture] = React.useState<{
    serial: string | null;
    recording: boolean;
    swipes: AppCloseGestureSwipe[];
    sessionId: number;
  }>({ serial: null, recording: false, swipes: [], sessionId: 0 });

  const start = React.useCallback((serial: string) => {
    setCapture(previous => ({
      serial,
      recording: true,
      swipes: [],
      sessionId: previous.sessionId + 1,
    }));
  }, []);

  const stop = React.useCallback(() => {
    setCapture(previous => ({ ...previous, recording: false }));
  }, []);

  const record = React.useCallback((serial: string, swipe: AppCloseGestureSwipe) => {
    setCapture(previous => {
      if (!previous.recording || previous.serial !== serial || previous.swipes.length >= 2) {
        return previous;
      }
      const swipes = [...previous.swipes, swipe];
      return { ...previous, swipes, recording: swipes.length < 2 };
    });
  }, []);

  const value = React.useMemo<AppCloseGestureRecorderValue>(() => ({
    ...capture,
    start,
    stop,
    record,
  }), [capture, start, stop, record]);

  return (
    <AppCloseGestureRecorderContext.Provider value={value}>
      {children}
    </AppCloseGestureRecorderContext.Provider>
  );
}
