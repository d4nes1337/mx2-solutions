"use client";

/**
 * "Save this draft?" on the way out of the builder.
 *
 * Nothing in the editor is autosaved any more, so leaving is the moment the
 * user decides whether the canvas becomes a draft. Three exits are covered:
 *
 *  - in-app links (header nav, cards, anything rendering an <a href>) are
 *    intercepted in the capture phase before Next's router sees the click;
 *  - reload / tab close gets the browser's own native confirm (beforeunload —
 *    the text is the browser's, not ours);
 *  - in-builder switches (open another draft, start a blank one) park their
 *    continuation in the leave guard rather than clobbering the canvas.
 *
 * Not covered: the browser Back button. Cancelling a popstate means pushing
 * history entries behind Next's App Router, which breaks routing more often
 * than it saves a draft — Back leaves without saving, like Discard.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { SheetPanel } from "@/components/ui/SheetPanel";
import { pushDraftToServer } from "@/lib/strategies/drafts-sync";
import { useLeaveGuard } from "@/lib/strategies/leave-guard";
import { hasUnsavedWork, useBuilderStore } from "@/lib/strategies/store";

/** Would leaving right now throw work away? Read fresh — listeners are global. */
const unsaved = (): boolean => hasUnsavedWork(useBuilderStore.getState());

export function UnsavedDraftPrompt() {
  const router = useRouter();
  const pending = useLeaveGuard((s) => s.pending);
  const request = useLeaveGuard((s) => s.request);
  const clear = useLeaveGuard((s) => s.clear);

  // Reload / close the tab: only the browser's native confirm is possible here.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // In-app navigation: capture phase, so Next's Link handler never runs.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab/window
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same route (the ?draft= canonicalization, in-page anchors) isn't leaving.
      if (url.pathname === window.location.pathname) return;
      if (!unsaved()) return;
      e.preventDefault();
      e.stopPropagation();
      const href = `${url.pathname}${url.search}${url.hash}`;
      request({ because: "leave the builder", run: () => router.push(href) });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router, request]);

  const resolve = (intent: () => void) => {
    clear();
    intent();
  };

  const save = () => {
    const record = useBuilderStore.getState().saveDraftNow();
    // localStorage is the source of truth (ADR-0019); the account copy is a
    // background nicety, so leaving never waits on the network — signed out or
    // offline, the draft is already safe.
    if (record) void pushDraftToServer(record);
    if (pending) resolve(pending.run);
  };

  const discard = () => {
    // Deletes any previously stored record too — "no" means no draft, not
    // "keep the last saved version of it".
    useBuilderStore.getState().clearCanvas();
    if (pending) resolve(pending.run);
  };

  return (
    <SheetPanel
      open={pending !== null}
      onClose={clear}
      size="sm"
      title="Save this draft?"
      description={`Unsaved work on the canvas. Keep it in your drafts before you ${pending?.because ?? "leave"}?`}
      footer={
        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={save}>
            Save draft
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" className="flex-1" onClick={clear}>
              Keep editing
            </Button>
            <Button variant="danger" className="flex-1" onClick={discard}>
              Don&apos;t save
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-[13px] leading-relaxed text-muted">
        Saved drafts show up under <span className="font-medium text-fg">Open a draft</span> in the
        builder and on your Strategies page. Choosing{" "}
        <span className="font-medium text-fg">Don&apos;t save</span> discards this canvas — the
        builder starts blank next time either way.
      </p>
    </SheetPanel>
  );
}
