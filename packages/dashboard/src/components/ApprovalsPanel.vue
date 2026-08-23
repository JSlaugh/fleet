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
    class="flex w-[26rem] max-w-[85vw] max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:shadow-xl shrink-0 flex-col border-l bg-card"
    aria-label="Pending approvals"
  >
    <header class="flex items-center gap-2 border-b p-4">
      <h2 class="text-sm font-semibold text-foreground">Approvals</h2>
      <span class="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {{ approvals.length }}
      </span>
      <button
        type="button"
        class="ml-auto rounded px-2 py-0.5 text-sm text-muted-foreground hover:bg-accent"
        @click="emit('close')"
      >
        Close
      </button>
    </header>
    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <p v-if="approvals.length === 0" class="text-xs text-muted-foreground">
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
          class="rounded-lg border border-warning/30 bg-warning/10 p-3"
        >
        <div class="flex items-center gap-2 text-xs">
          <span class="font-semibold text-foreground">{{ approval.toolName }}</span>
          <span class="text-muted-foreground">{{ approval.project }}#{{ approval.issueNumber }}</span>
          <span class="ml-auto text-muted-foreground">{{ formatTime(approval.createdAt) }}</span>
        </div>
        <pre
          class="mt-2 max-h-48 overflow-auto rounded bg-card p-2 font-mono text-[11px] leading-relaxed text-foreground/80"
        >{{ pretty(approval.input) }}</pre>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="rounded bg-success px-3 py-1 text-xs font-medium text-background hover:bg-success/90"
            @click="emit('resolve', approval.id, 'allow')"
          >
            Allow
          </button>
          <button
            type="button"
            class="rounded bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
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
