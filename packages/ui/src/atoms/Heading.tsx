import type { ReactNode } from "react";
import { cn } from "../utils/cn";

/**
 * Sans-serif extrabold headline. Spec: §07.
 * Use the serif italic via `<em>` inside children for marketing-style
 * emotional beats — Space Grotesk does not get italicised on its own.
 */
export interface HeadingProps {
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  as?: "h1" | "h2" | "h3" | "h4" | "div";
  className?: string;
}

const sizeClass: Record<NonNullable<HeadingProps["size"]>, string> = {
  sm: "text-[18px]",
  md: "text-[22px]",
  lg: "text-[28px]",
  xl: "text-[32px]",
};

export function Heading({
  children,
  size = "lg",
  as: Tag = "div",
  className,
}: HeadingProps) {
  return (
    <Tag
      className={cn(
        "font-sans font-extrabold leading-[1.05] tracking-[-0.5px] text-ink",
        sizeClass[size],
        className,
      )}
    >
      {children}
    </Tag>
  );
}
