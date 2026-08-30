import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn } from "../lib/utils";
import { AppHeader } from "./AppHeader";
import { Button } from "./ui/button";

const tabs = (worldId: string) =>
  [
    { to: `/w/${worldId}`, label: "会话", end: true },
    { to: `/w/${worldId}/world`, label: "世界" },
    { to: `/w/${worldId}/cards`, label: "角色" },
    { to: `/w/${worldId}/lore`, label: "世界书" },
  ] as const;

export function WorkspaceShell({
  worldId,
  name,
  onNewSession,
  creating,
  children,
}: {
  worldId: string;
  name: string;
  onNewSession: () => void;
  creating?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="font-ui text-xs uppercase tracking-wide text-secondary">{worldId}</p>
            <h1 className="truncate font-display text-3xl font-semibold">{name}</h1>
          </div>
          <Button type="button" disabled={creating} onClick={onNewSession}>
            开新局
          </Button>
        </div>
        <nav className="mx-auto mt-4 flex max-w-6xl gap-1 overflow-x-auto" aria-label="工作区">
          {tabs(worldId).map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={"end" in tab ? tab.end : false}
              className={({ isActive }) =>
                cn(
                  "min-h-11 shrink-0 px-4 py-2 font-ui text-sm transition-colors duration-200",
                  isActive
                    ? "border-b-2 border-accent text-foreground"
                    : "border-b-2 border-transparent text-secondary hover:text-foreground",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</div>
    </div>
  );
}
