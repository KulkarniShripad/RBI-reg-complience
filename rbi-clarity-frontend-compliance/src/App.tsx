import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Landing from "./pages/Landing";
import Dashboard from "./pages/Dashboard";
import ChatPage from "./pages/ChatPage";
import UploadPage from "./pages/UploadPage";
import CircularsPage from "./pages/CircularsPage";
import RulesPage from "./pages/RulesPage";
import CompliancePage from "./pages/CompliancePage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<Dashboard />}>
            <Route index element={<ChatPage />} />
            <Route path="upload" element={<UploadPage />} />
            <Route path="circulars" element={<CircularsPage />} />
            <Route path="rules" element={<RulesPage />} />
            <Route path="compliance" element={<CompliancePage />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
