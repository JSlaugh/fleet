import { toast } from "vue-sonner";

/**
 * Action failures go to toasts (#208): the board store's `error` ref is
 * cleared by every successful background load, so a mutation's message could
 * vanish before the operator saw it. `error` carries board fetch/connectivity
 * problems only.
 */
export function toastActionError(context: string, err: unknown) {
  toast.error(context, { description: err instanceof Error ? err.message : String(err), duration: 8000 });
}
