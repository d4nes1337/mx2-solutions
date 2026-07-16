"use client";

/**
 * Page-specific tour definitions. Steps targeting elements that aren't on the
 * page (flag off, signed out) are skipped automatically by the Tour engine.
 */
import { Tour } from "./Tour";

export function HomeTour() {
  return (
    <Tour
      storageKey="arima.tour.home.v1"
      invite={{
        title: "New to arima?",
        body: "A 30-second walkthrough: type a thought, watch it become a live trading strategy.",
      }}
      steps={[
        {
          target: "hero-prompt",
          title: "Type a thought",
          body: "Describe a trade in plain words — the AI assembles a working strategy on a visual canvas, with real Polymarket prices.",
        },
        {
          target: "hero-showcase",
          title: "Strategies that would have paid",
          body: "Live markets, backtested over the last 30 days. Flip through them, open one in the builder, or steal its prompt.",
        },
        {
          target: "nav-markets",
          title: "Find any market",
          body: "Every market page shows concrete entry ideas under the chart, plus the order book, latest trades and top holders.",
        },
        {
          target: "nav-smart-orders",
          title: "Your Smart Orders",
          body: "Everything you build lives here — watching live prices, triggered, or done.",
        },
        {
          target: "nav-wallet",
          title: "Get trade-ready",
          body: "Create the arima trading wallet and top it up with USDC — that's the whole setup.",
        },
        {
          target: "theme-switcher",
          title: "Make it yours",
          body: "Light, Paper, or Dark — switch anytime. Replay this tour from the ? button.",
        },
      ]}
    />
  );
}

export function BuilderTour() {
  return (
    <Tour
      storageKey="arima.tour.builder.v1"
      invite={{
        title: "First time in the builder?",
        body: "Four quick stops: the canvas, the plain-English sentence, the projection, and the save button.",
      }}
      steps={[
        {
          target: "builder-canvas",
          title: "Your strategy as blocks",
          body: "Markets feed conditions; conditions gate the action. Tap a block to edit it in the side panel, or expand/resize it to edit right on the canvas.",
        },
        {
          target: "builder-add",
          title: "Add anything from here",
          body: "Conditions, markets, logic groups and ready-made presets — including trailing stops and rewards farming.",
        },
        {
          target: "sentence-bar",
          title: "Always in plain English",
          body: "The canvas always reads back as one sentence. Click any chip to jump to that part.",
        },
        {
          target: "builder-projection",
          title: "Instant reality check",
          body: "Payoff if it fills, and whether this would have triggered over the last 30 days — before you commit anything.",
        },
        {
          target: "builder-save",
          title: "Arm it",
          body: "Save to start watching live prices. Nothing trades by itself — orders are prepared for your confirmation.",
        },
      ]}
    />
  );
}
