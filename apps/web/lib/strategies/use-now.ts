"use client";

import { useEffect, useState } from "react";

/**
 * 1-second local clock tick so dwell bars / countdowns advance smoothly
 * between server polls. Server timestamps stay the truth — this only moves
 * the "now" they're measured against.
 */
export const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return now;
};
