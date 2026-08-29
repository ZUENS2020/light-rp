import { Settings } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "./ui/button";

export function SettingsLink() {
  return (
    <Button variant="ghost" size="icon" asChild>
      <Link to="/settings" aria-label="设置">
        <Settings className="h-5 w-5" />
      </Link>
    </Button>
  );
}
