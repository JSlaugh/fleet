<script setup lang="ts">
import { ref } from "vue";
import type { PendingApproval } from "@fleet/shared";
import { formatTime } from "../lib/format.ts";
import { usePanelFocus } from "../composables/usePanelFocus.ts";
import QuestionCard from "./QuestionCard.vue";

defineProps<{
  approvals: PendingApproval[];
}>();

const emit = defineEmits<{
  resolve: [id: string, decision: "allow" | "deny" | "answer", message?: string, done?: (ok: boolean) => void];
  close: [];
}>();

const panelRoot = ref<HTMLElement>();
usePanelFocus(panelRoot, () => emit("close"));

function pretty(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
</script>

<template>
  <aside
    ref="panelRoot"
    tabindex="-1"
    class="flex w-[26rem] shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
    aria-label="Pending approvals"
  >
    <header class="flex items-center gap-2 border-b border-neutral-200 p-4 dark:border-neutral-700">
      <h2 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Approvals</h2>
      <span class="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
        {{ approvals.length }}
      </span>
      <button
        type="button"
        class="ml-auto rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        @click="emit('close')"
      >
        Close
      </button>
    </header>
    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <p v-if="approvals.length === 0" class="text-xs text-neutral-400 dark:text-neutral-500">
        No pending approvals. Workers request approval here for any tool outside their allowlist.
      </p>
      <template v-for="approval in approvals" :key="approval.id">
        <QuestionCard
          v-if="approval.kind === 'question'"
          :approval="approval"
          @answer="(message, done) => emit('resolve', approval.id, 'answer', message, done)"
          @dismiss="emit('resolve', approval.id, 'deny')"
        />
        <article
          v-else
          class="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950"
        >
        <div class="flex items-center gap-2 text-xs">
          <span class="font-semibold text-neutral-900 dark:text-neutral-100">{{ approval.toolName }}</span>
          <span class="text-neutral-500 dark:text-neutral-400">{{ approval.project }}#{{ approval.issueNumber }}</span>
          <span class="ml-auto text-neutral-400 dark:text-neutral-500">{{ formatTime(approval.createdAt) }}</span>
        </div>
        <pre
          class="mt-2 max-h-48 overflow-auto rounded bg-white p-2 font-mono text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
        >{{ pretty(approval.input) }}</pre>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700"
            @click="emit('resolve', approval.id, 'allow')"
          >
            Allow
          </button>
          <button
            type="button"
            class="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
            @click="emit('resolve', approval.id, 'deny')"
          >
            Deny
          </button>
          </div>
        </article>
      </template>
    </div>
  </aside>
</template>
