import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SettingsLink } from "./SettingsLink";
import { ThemeToggle } from "./ThemeToggle";

export function AppHeader({
  backTo,
  backLabel = "返回",
  extra,
}: {
  backTo?: string;
  backLabel?: string;
  extra?: ReactNode;
}) {
  return (
    <header className="bg-background/95 sticky top-0 z-header flex items-center gap-3 border-b border-border px-4 py-3 backdrop-blur">
      <Link to={backTo || "/"} className="font-ui text-sm tracking-wide text-secondary hover:text-foreground">
        {backTo ? backLabel : "Light RP"}
      </Link>
      <div className="ml-auto flex items-center gap-1">
        {extra}
        <SettingsLink />
        <ThemeToggle />
      </div>
    </header>
  );
}
