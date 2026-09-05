import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AuthGate, hasStoredToken } from "./components/AuthGate";
import { OverviewPage } from "./pages/OverviewPage";
import { SuppliersPage } from "./pages/SuppliersPage";
import { ProductsPage } from "./pages/ProductsPage";
import { ScoutedItemsPage } from "./pages/ScoutedItemsPage";
import { OrdersPage } from "./pages/OrdersPage";
import { LogsPage } from "./pages/LogsPage";
import { ScrapersPage } from "./pages/ScrapersPage";
import { AiProvidersPage } from "./pages/AiProvidersPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastProvider } from "./components/ui/Toast";
import { SearchProvider } from "./lib/searchContext";

export default function App() {
  const [authenticated, setAuthenticated] = useState(hasStoredToken());

  // F24: listen for 401 responses dispatched by api.ts — any expired or
  // invalidated session token causes an immediate return to the login screen
  // rather than leaving the user on a broken dashboard.
  useEffect(() => {
    const handleExpired = () => setAuthenticated(false);
    window.addEventListener("auth:expired", handleExpired);
    return () => window.removeEventListener("auth:expired", handleExpired);
  }, []);

  if (!authenticated) {
    return (
      <ToastProvider>
        <AuthGate onAuthenticated={() => setAuthenticated(true)} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <BrowserRouter>
        <SearchProvider>
          <AppShell>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/scouted" element={<ScoutedItemsPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/scrapers" element={<ScrapersPage />} />
              <Route path="/ai-providers" element={<AiProvidersPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </AppShell>
        </SearchProvider>
      </BrowserRouter>
    </ToastProvider>
  );
}
