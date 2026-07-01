"use client";

import { useState } from "react";
import type { ComponentProps } from "react";
import type { FlexCardModel } from "./types";
import { FlexCardSheet } from "./FlexCardSheet";
import { Button } from "../ui";

/**
 * Opens the flex-card sheet. `makeModel` is called on click so the card always
 * reflects the latest data (and `generatedAt` is fresh).
 */
export function ShareButton({
  makeModel,
  label = "Share",
  icon = true,
  variant = "ghost",
  size = "sm",
  className,
  title,
}: {
  makeModel: () => FlexCardModel;
  label?: string;
  icon?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
  title?: string;
}) {
  const [model, setModel] = useState<FlexCardModel | null>(null);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        title={title ?? "Share a PnL card"}
        aria-label={label ? undefined : (title ?? "Share a PnL card")}
        onClick={() => setModel(makeModel())}
      >
        {icon ? "↗ " : ""}
        {label}
      </Button>
      {model ? <FlexCardSheet model={model} open onClose={() => setModel(null)} /> : null}
    </>
  );
}
