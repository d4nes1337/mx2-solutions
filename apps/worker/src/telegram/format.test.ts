import { describe, expect, it } from "vitest";
import { escapeHtml, formatCents, formatNotification } from "./format.js";

const BASE = "https://app.example.com/";

describe("escapeHtml", () => {
  it("escapes the HTML-parse-mode metacharacters", () => {
    expect(escapeHtml(`<b>&"rule"</b>`)).toBe(`&lt;b&gt;&amp;"rule"&lt;/b&gt;`);
  });
});

describe("formatCents", () => {
  it("renders 0..1 prices as whole cents", () => {
    expect(formatCents(0.47)).toBe("47¢");
    expect(formatCents(0.005)).toBe("1¢");
  });

  it("tolerates junk", () => {
    expect(formatCents(undefined)).toBe("—");
    expect(formatCents("nope")).toBe("—");
  });
});

describe("formatNotification", () => {
  it("order_awaiting_signature carries the sign link + dismiss callback", () => {
    const msg = formatNotification(
      "order_awaiting_signature",
      {
        triggerId: "trig-1",
        ruleId: "rule-1",
        ruleName: "BTC dip <buy>",
        side: "buy",
        price: 0.45,
        size: 100,
        orderType: "GTC",
        bestBid: 0.44,
        bestAsk: 0.46,
      },
      { appBaseUrl: BASE, signUrl: "https://app.example.com/m/t/trig-1?t=tok" },
    );
    expect(msg.html).toContain("Order ready to sign");
    // Rule name is user content — must arrive escaped.
    expect(msg.html).toContain("BTC dip &lt;buy&gt;");
    expect(msg.html).toContain("BUY 100 @ 45¢ · GTC");
    expect(msg.html).toContain("Book: 44¢ bid / 46¢ ask");
    expect(msg.buttons).toEqual([
      [{ text: "Open & sign", url: "https://app.example.com/m/t/trig-1?t=tok" }],
      [{ text: "Dismiss", callback_data: "dismiss:trig-1" }],
    ]);
  });

  it("order_awaiting_signature with a Mini App url leads with web_app, browser link demotes", () => {
    const msg = formatNotification(
      "order_awaiting_signature",
      { triggerId: "trig-1", side: "buy", price: 0.45, size: 100, orderType: "GTC" },
      {
        appBaseUrl: BASE,
        signUrl: "https://app.example.com/m/t/trig-1?t=tok",
        miniappSignUrl: "https://app.example.com/m/t/trig-1",
      },
    );
    expect(msg.buttons[0]).toEqual([
      { text: "Open & sign", web_app: { url: "https://app.example.com/m/t/trig-1" } },
    ]);
    expect(msg.buttons[1]).toEqual([
      { text: "Open in browser", url: "https://app.example.com/m/t/trig-1?t=tok" },
    ]);
  });

  it("order_awaiting_signature without a sign url still renders (no dead button)", () => {
    const msg = formatNotification(
      "order_awaiting_signature",
      { triggerId: "trig-1", side: "sell", price: 0.6, size: 5, orderType: "FAK" },
      { appBaseUrl: BASE },
    );
    expect(msg.buttons).toEqual([[{ text: "Dismiss", callback_data: "dismiss:trig-1" }]]);
  });

  it("rule_alert links to the strategy", () => {
    const msg = formatNotification(
      "rule_alert",
      { ruleId: "rule-9", ruleName: "Alert me", bestBid: 0.2, bestAsk: 0.22 },
      { appBaseUrl: BASE },
    );
    expect(msg.html).toContain("Alert triggered");
    expect(msg.buttons[0]![0]!.url).toBe("https://app.example.com/smart-orders/rule-9");
  });

  it("order_auto_executed is informational — no sign link ever", () => {
    const msg = formatNotification(
      "order_auto_executed",
      { ruleId: "rule-2", side: "buy", price: 0.3, size: 10, orderType: "FOK" },
      { appBaseUrl: BASE },
    );
    expect(msg.html).toContain("auto-executed");
    expect(JSON.stringify(msg.buttons)).not.toContain("/m/t/");
  });

  it("order_filled shows the average fill price", () => {
    const msg = formatNotification(
      "order_filled",
      { side: "buy", filledSize: "10", avgFillPrice: "0.415" },
      { appBaseUrl: BASE },
    );
    expect(msg.html).toContain("Order filled");
    expect(msg.html).toContain("BUY 10 @ 42¢");
  });
});
