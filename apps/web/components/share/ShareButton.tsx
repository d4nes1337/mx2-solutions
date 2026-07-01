"use client";

import { useState } from "react";
import type { ComponentProps } from "react";
import type { FlexCardModel } from "./types";
import { FlexCardSheet } from "./FlexCardSheet";
import { Button } from "../ui";

async function imageUrlToDataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  try {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Failed to inline avatar"));
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function inlineAvatar(model: FlexCardModel): Promise<FlexCardModel> {
  if (!model.avatarUrl) return model;
  const dataUrl = await imageUrlToDataUrl(model.avatarUrl);
  return dataUrl ? { ...model, avatarUrl: dataUrl } : model;
}

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
  const [pending, setPending] = useState(false);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        title={title ?? "Share a PnL card"}
        aria-label={label ? undefined : (title ?? "Share a PnL card")}
        disabled={pending}
        onClick={async () => {
          setPending(true);
          try {
            setModel(await inlineAvatar(makeModel()));
          } finally {
            setPending(false);
          }
        }}
      >
        {icon ? "↗ " : ""}
        {pending ? "Preparing…" : label}
      </Button>
      {model ? <FlexCardSheet model={model} open onClose={() => setModel(null)} /> : null}
    </>
  );
}
