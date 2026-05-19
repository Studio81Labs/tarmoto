import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Card · three flavors. Spec: §11.
 *  - default · cream-on-cream hairline (most surfaces)
 *  - paper · paper fill for inner cells nested inside another card
 *  - ink · ink fill, cream type. "Hero" call-out — max once per view.
 */
export type CardVariant = "default" | "paper" | "paper-2" | "ink";

const variantClass: Record<CardVariant, string> = {
  default: "bg-cream border-line text-ink",
  paper: "bg-paper border-line text-ink",
  "paper-2": "bg-paper-2 border-line text-ink",
  ink: "bg-ink border-ink text-cream",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  /** Skip the default 18 px padding for media or full-bleed contents. */
  padded?: boolean;
  children?: ReactNode;
}

export function Card({
  variant = "default",
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        "rounded-[14px] border",
        padded && "p-[18px]",
        variantClass[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
