<script setup lang="ts">
import type { AttentionItem, AttentionKind } from "../lib/board.ts";
import { formatWait } from "../lib/format.ts";

defineProps<{
  items: AttentionItem[];
}>();

const emit = defineEmits<{
  select: [project: string, issueNumber: number];
  openApprovals: [];
}>();

const KIND_LABEL: Record<AttentionKind, string> = {
  approval: "approval",
  "needs-input": "needs input",
  failed: "failed",
  review: "review",
};

const KIND_CLASS: Record<AttentionKind, string> = {
  approval: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  "needs-input": "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  failed: "bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-200",
  review: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

function onSelect(item: AttentionItem) {
  if (item.kind === "approval") emit("openApprovals");
  else emit("select", item.project, item.issueNumber);
}
</script>

<template>
  <div
    class="flex shrink-0 flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-900"
    aria-label="Needs your attention"
  >
    <div class="flex items-center gap-1.5 px-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
      Needs you
      <span class="rounded-full bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {{ items.length }}
      </span>
    </div>
    <div
      v-for="item in items"
      :key="`${item.kind}:${item.approvalId ?? `${item.project}#${item.issueNumber}`}`"
      class="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
    >
      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left" @click="onSelect(item)">
        <span class="shrink-0 rounded-full px-2 py-0.5 font-medium" :class="KIND_CLASS[item.kind]">
          {{ KIND_LABEL[item.kind] }}
        </span>
        <span class="shrink-0 font-medium text-neutral-700 dark:text-neutral-200">{{ item.project }}#{{ item.issueNumber }}</span>
        <span class="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">{{ item.detail }}</span>
      </button>
      <a
        v-if="item.prUrl ?? item.url"
        :href="item.prUrl ?? item.url"
        target="_blank"
        rel="noopener"
        class="shrink-0 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
        :title="item.prUrl ? 'Open PR' : 'Open issue'"
        :aria-label="item.prUrl ? 'Open PR' : 'Open issue'"
      >
        ↗
      </a>
      <span
        class="shrink-0 tabular-nums pr-1 text-neutral-400 dark:text-neutral-500"
        :title="`Waiting since ${new Date(item.since).toLocaleString()}`"
      >
        {{ formatWait(item.waitMs) }}
      </span>
    </div>
  </div>
</template>
