"use client";

import { useEffect, useState } from "react";
import { BellRing, ExternalLink, Loader2, MessageCircle, Send } from "lucide-react";
import {
  useCreateLinkCode,
  useDiscordOauthUrl,
  useFeatureFlags,
  useNotificationChannels,
  useUnlinkChannel,
  useUpdateChannelPreferences,
} from "@/lib/queries";
import type { LinkCodeResponse, NotificationChannelItem, NotificationKind } from "@/lib/types";
import { Badge, Button, Card, CardHeader, ErrorNote } from "@/components/ui";
import { CopyButton, QrBadge } from "./funds/shared";

const KIND_LABELS: Record<NotificationKind, string> = {
  order_awaiting_signature: "Order ready to sign",
  rule_alert: "Price & rule alerts",
  order_auto_executed: "Auto-executed orders",
  order_filled: "Order fills",
  deposit_completed: "Deposits",
  withdrawal_completed: "Withdrawals",
};

/**
 * "Connected apps" card on the Wallet page: link a Telegram (later Discord)
 * account for trade notifications. Linking is code-based — we mint a
 * single-use code and hand the user a t.me deep link; the bot completes the
 * link on /start. While a code is outstanding we poll the channel list so the
 * card flips to "linked" the moment the bot confirms.
 */
export function NotificationsSection({ signedIn }: { signedIn: boolean }) {
  const flags = useFeatureFlags();
  const notificationsEnabled = flags.data?.notifications ?? false;

  const [pendingLink, setPendingLink] = useState<LinkCodeResponse | null>(null);
  const channels = useNotificationChannels(signedIn && notificationsEnabled, pendingLink !== null);
  const createLinkCode = useCreateLinkCode();
  const discordOauth = useDiscordOauthUrl();
  const unlink = useUnlinkChannel();

  const allChannels = channels.data?.channels ?? [];
  const telegramChannels = allChannels.filter((c) => c.channel === "telegram");
  const discordChannels = allChannels.filter((c) => c.channel === "discord");

  // The bot completed /start on its side: a telegram channel appeared while a
  // link code was outstanding → collapse the pending panel.
  useEffect(() => {
    if (pendingLink && telegramChannels.length > 0) setPendingLink(null);
  }, [pendingLink, telegramChannels.length]);

  // Expired codes are useless — drop the panel when the TTL passes.
  useEffect(() => {
    if (!pendingLink) return;
    const ms = new Date(pendingLink.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      setPendingLink(null);
      return;
    }
    const t = setTimeout(() => setPendingLink(null), ms);
    return () => clearTimeout(t);
  }, [pendingLink]);

  if (!signedIn || !notificationsEnabled) return null;

  const telegramEnabled = channels.data?.telegramEnabled ?? false;
  const discordEnabled = channels.data?.discordEnabled ?? false;

  const connectDiscord = () => {
    discordOauth.mutate(undefined, {
      onSuccess: (res) => {
        // Give the user the guild invite in a new tab BEFORE the OAuth bounce
        // — the bot can only DM members of the project guild.
        if (res.guildInviteUrl) window.open(res.guildInviteUrl, "_blank", "noopener");
        window.location.href = res.url;
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <div className="text-[13px] font-semibold text-fg">Notifications</div>
          <div className="text-[12px] text-muted">
            Get trade alerts and sign prepared orders from your phone.
          </div>
        </div>
      </CardHeader>
      <div className="space-y-3 p-4">
        {createLinkCode.isError ? (
          <ErrorNote message="Could not create a link code. Try again." />
        ) : null}

        {allChannels.map((c) => (
          <ChannelRow
            key={c.id}
            channel={c}
            kinds={channels.data?.kinds ?? []}
            onUnlink={() => unlink.mutate(c.id)}
            unlinking={unlink.isPending}
          />
        ))}

        {telegramChannels.length === 0 && !pendingLink ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <Send className="h-4 w-4 text-muted" aria-hidden />
              <div>
                <div className="text-[13px] font-medium text-fg">Telegram</div>
                <div className="text-[12px] text-muted">
                  {telegramEnabled
                    ? "Order alerts + one-tap open to sign."
                    : "Not enabled on this server."}
                </div>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => createLinkCode.mutate("telegram", { onSuccess: setPendingLink })}
              disabled={!telegramEnabled || createLinkCode.isPending}
            >
              {createLinkCode.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              Connect
            </Button>
          </div>
        ) : null}

        {pendingLink ? (
          <PendingLinkPanel link={pendingLink} onCancel={() => setPendingLink(null)} />
        ) : null}

        {discordEnabled && discordChannels.length === 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <MessageCircle className="h-4 w-4 text-muted" aria-hidden />
              <div>
                <div className="text-[13px] font-medium text-fg">Discord</div>
                <div className="text-[12px] text-muted">
                  DM alerts with sign links. Join the project server so the bot can DM you.
                </div>
              </div>
            </div>
            <Button size="sm" onClick={connectDiscord} disabled={discordOauth.isPending}>
              {discordOauth.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              Connect
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function PendingLinkPanel({ link, onCancel }: { link: LinkCodeResponse; onCancel: () => void }) {
  return (
    <div className="rounded-lg border border-brand/40 bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <BellRing className="h-4 w-4 text-accent" aria-hidden />
            Finish linking in Telegram
            <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          </div>
          <p className="text-[12px] leading-relaxed text-muted">
            Open the bot and press <span className="text-fg">Start</span> — the code is single-use
            and expires in 10 minutes. On desktop, scan the QR with your phone.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {link.deepLink ? (
              <a href={link.deepLink} target="_blank" rel="noreferrer">
                <Button size="sm">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  Open Telegram
                </Button>
              </a>
            ) : null}
            {link.deepLink ? <CopyButton text={link.deepLink} /> : null}
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
        {link.deepLink ? <QrBadge value={link.deepLink} /> : null}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  kinds,
  onUnlink,
  unlinking,
}: {
  channel: NotificationChannelItem;
  kinds: NotificationKind[];
  onUnlink: () => void;
  unlinking: boolean;
}) {
  const updatePrefs = useUpdateChannelPreferences();

  const toggleKind = (kind: NotificationKind, enabled: boolean) => {
    updatePrefs.mutate({
      id: channel.id,
      preferences: { ...channel.preferences, [kind]: enabled },
    });
  };

  const isTelegram = channel.channel === "telegram";
  const Icon = isTelegram ? Send : MessageCircle;

  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon className="h-4 w-4 text-accent" aria-hidden />
          <div>
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              {isTelegram ? "Telegram" : "Discord"}
              <Badge tone="pos">Linked</Badge>
            </div>
            <div className="text-[12px] text-muted">
              {channel.externalUsername ? `@${channel.externalUsername}` : "Connected account"}
            </div>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onUnlink} disabled={unlinking}>
          Disconnect
        </Button>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[12px] font-medium text-muted">
          Notification types
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {kinds.map((kind) => {
            const enabled = channel.preferences[kind] !== false;
            return (
              <label
                key={kind}
                className="flex cursor-pointer items-center gap-2 text-[12px] text-fg"
              >
                <input
                  type="checkbox"
                  className="accent-[var(--brand-strong)]"
                  checked={enabled}
                  onChange={(e) => toggleKind(kind, e.target.checked)}
                />
                {KIND_LABELS[kind]}
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}
