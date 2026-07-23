"use client";

/**
 * Opt-in alert sound (brief §6.8). A single short, neutral ping bundled locally
 * (`/sounds/alert.wav`), played at most once when a previously-unseen trigger
 * enters Ready to sign — never on poll/render/focus/route. Browser autoplay
 * policy requires a prior user gesture; playback errors are swallowed so a
 * blocked play never breaks the app.
 */
const SRC = "/sounds/alert.wav";

let audio: HTMLAudioElement | null = null;

const el = (): HTMLAudioElement | null => {
  if (typeof Audio === "undefined") return null;
  if (!audio) audio = new Audio(SRC);
  return audio;
};

export const playAlertSound = (volume: number): void => {
  const a = el();
  if (!a) return;
  try {
    a.currentTime = 0;
    a.volume = Math.max(0, Math.min(1, volume));
    void a.play().catch(() => {
      /* autoplay blocked / no gesture — silently ignore */
    });
  } catch {
    /* ignore */
  }
};
