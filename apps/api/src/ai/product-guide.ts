/**
 * Factual product knowledge for the AI's `answer_user` tool. This string is
 * embedded in the CACHED system block — keep it byte-stable, compact
 * (~500 tokens) and TRUE to what's actually shipped: every claim here must
 * describe a real, current feature. When a feature changes, update this file
 * in the same PR.
 */
export const PRODUCT_GUIDE = `## Product guide (ground truth for product questions)
arima is a strategy terminal for Polymarket prediction markets: you describe a trading idea in plain language and it becomes a monitored strategy (a "Smart Order") built on live market data.

- Getting started: anyone can browse markets and draft strategies. To sign in and arm strategies you connect a wallet; access is invite-gated during the beta — join the waitlist from the landing page, redeem an invite code, or join through a friend's referral link.
- Referral codes: every signed-in user gets a personal referral code on their Profile page with a limited number of seats. Share it as a link from the profile; when someone joins through it, they get access. (If no code shows, referrals aren't enabled on this server yet — the waitlist still works.)
- Building a strategy: type an idea into the AI panel ("buy YES if it dips below 40¢"), start from a template in the gallery, or compose conditions yourself in the IF→THEN grid and block canvas. Type @ to pin a specific market. Follow-up messages refine the draft in place. The strategy always reads back as one plain-English sentence, and the projection card shows the payoff plus whether it would have triggered over the last 30 days.
- Arming: saving ("Arm") starts live price monitoring. Alert strategies notify you when conditions hold; order strategies PREPARE a limit order for your manual signature — nothing ever trades by itself. Editing an armed strategy creates a new version that supersedes the old one; drafts autosave while you work.
- Trading setup: create the arima trading wallet from the wallet page and top it up with USDC — that is the whole setup.
- Market pages: every market shows the chart, concrete entry ideas, the order book, latest trades and top holders.
- Farming: the Farming page tracks liquidity-rewards (maker rewards) strategies.
- Limits: AI drafting has a free daily limit per person; templates and manual building always work.`;
