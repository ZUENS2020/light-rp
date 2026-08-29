import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { PlayPage } from "./pages/PlayPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/w/:worldId" element={<WorkspacePage />} />
        <Route path="/w/:worldId/world" element={<WorkspacePage />} />
        <Route path="/w/:worldId/cards" element={<WorkspacePage />} />
        <Route path="/w/:worldId/lore" element={<WorkspacePage />} />
        <Route path="/w/:worldId/s/:sessionId" element={<PlayPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
