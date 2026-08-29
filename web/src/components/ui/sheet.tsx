import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: DialogPrimitive.DialogContentProps & { side?: "right" | "left" }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-sheet bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-sheet flex h-full w-full max-w-md flex-col bg-surface p-6 shadow-xl",
          side === "right" ? "right-0 top-0" : "left-0 top-0",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label="关闭面板">
            <X className="h-5 w-5" />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetTitle(props: DialogPrimitive.DialogTitleProps) {
  return <DialogPrimitive.Title className="font-display text-2xl font-semibold" {...props} />;
}
