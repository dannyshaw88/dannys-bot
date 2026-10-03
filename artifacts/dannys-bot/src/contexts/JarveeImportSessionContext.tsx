import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

export type JarveeProfile = Record<string, string | string[] | undefined>;

interface JarveeImportSession {
  fileName: string;
  setFileName: Dispatch<SetStateAction<string>>;
  profiles: JarveeProfile[];
  setProfiles: Dispatch<SetStateAction<JarveeProfile[]>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  clearImport: () => void;
}

const JarveeImportSessionContext = createContext<JarveeImportSession | null>(null);

export function JarveeImportSessionProvider({ children }: { children: ReactNode }) {
  const [fileName, setFileName] = useState("");
  const [profiles, setProfiles] = useState<JarveeProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const clearImport = () => {
    setFileName("");
    setProfiles([]);
    setLoading(false);
    setError("");
  };

  return (
    <JarveeImportSessionContext.Provider
      value={{
        fileName,
        setFileName,
        profiles,
        setProfiles,
        loading,
        setLoading,
        error,
        setError,
        clearImport,
      }}
    >
      {children}
    </JarveeImportSessionContext.Provider>
  );
}

export function useJarveeImportSession() {
  const session = useContext(JarveeImportSessionContext);
  if (!session) {
    throw new Error("useJarveeImportSession must be used within JarveeImportSessionProvider");
  }
  return session;
}