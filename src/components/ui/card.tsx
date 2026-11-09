import * as React from "react";
import { cn } from "../../lib/utils";
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...p }, r) => (
    <div
      ref={r}
      className={cn("rounded-xl border border-zinc-800 bg-zinc-900", className)}
      {...p}
    />
  ),
);
Card.displayName = "Card";
export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...p }, r) => <div ref={r} className={cn("p-4", className)} {...p} />,
);
CardContent.displayName = "CardContent";
