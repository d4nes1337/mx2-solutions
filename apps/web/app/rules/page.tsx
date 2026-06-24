"use client";

import { useFeatureFlags } from "@/lib/queries";
import { useSession } from "@/lib/auth";
import { Card, CardHeader, Empty } from "@/components/ui";
import { RuleList } from "@/components/RuleList";
import { TriggerAlert } from "@/components/TriggerAlert";

export default function RulesPage() {
  const session = useSession();
  const flags = useFeatureFlags();
  const signedIn = Boolean(session.data);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Conditional rules</h1>
        <p className="mt-1 text-xs text-muted">
          Rules watch the live market and, when your condition holds continuously, alert you and
          prepare an order for manual confirmation. Nothing is ever submitted without your
          signature.
        </p>
      </div>

      {flags.data && !flags.data.conditionalRules ? (
        <Empty>Conditional rules are disabled on this server.</Empty>
      ) : !signedIn ? (
        <Empty>Sign in to view and manage your conditional rules.</Empty>
      ) : (
        <>
          <TriggerAlert />
          <Card>
            <CardHeader>Your rules</CardHeader>
            <div className="p-4">
              <RuleList />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
