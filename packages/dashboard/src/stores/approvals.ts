import { ref } from "vue";
import { defineStore } from "pinia";
import type { PendingApproval } from "@fleet/shared";
import { fetchApprovals, resolveApproval } from "../lib/api.ts";
import { toastActionError } from "../lib/toast.ts";
import { usePolledResource } from "../composables/usePolledResource.ts";

/** Pending approvals plus the resolve flow. start()/stop() are driven by the app shell. */
export const useApprovalsStore = defineStore("approvals", () => {
  const approvals = ref<PendingApproval[]>([]);
  /** Persistent while true — the header shows "approvals unavailable" until a load succeeds again. */
  const approvalsError = ref<string>();

  async function load(isStale: () => boolean) {
    try {
      const fetched = (await fetchApprovals()).approvals;
      if (isStale()) return;
      approvals.value = fetched;
      approvalsError.value = undefined;
    } catch (err) {
      if (isStale()) return;
      approvalsError.value = err instanceof Error ? err.message : String(err);
    }
  }

  const poll = usePolledResource(load, 15000);

  async function resolve(
    id: string,
    decision: "allow" | "deny" | "answer",
    message?: string,
    done?: (ok: boolean) => void,
  ) {
    try {
      await resolveApproval(id, decision, message);
      await poll.refresh();
      done?.(true);
    } catch (err) {
      toastActionError("Failed to resolve approval", err);
      done?.(false);
    }
  }

  return {
    approvals,
    approvalsError,
    refresh: poll.refresh,
    start: poll.start,
    stop: poll.stop,
    resolve,
  };
});
