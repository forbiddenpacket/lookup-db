import { cn } from "../../lib/utils";
export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[10px] font-semibold",
        className,
      )}
      {...props}
    />
  );
}
