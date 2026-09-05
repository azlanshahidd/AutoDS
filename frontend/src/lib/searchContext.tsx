import { createContext, useContext, useState, ReactNode } from "react";

interface SearchContextValue {
  query:    string;
  setQuery: (q: string) => void;
  open:     boolean;
  setOpen:  (o: boolean) => void;
}

const SearchContext = createContext<SearchContextValue>({
  query: "", setQuery: () => {}, open: false, setOpen: () => {},
});

export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [open,  setOpen]  = useState(false);
  return (
    <SearchContext.Provider value={{ query, setQuery, open, setOpen }}>
      {children}
    </SearchContext.Provider>
  );
}

export function useSearch() {
  return useContext(SearchContext);
}
