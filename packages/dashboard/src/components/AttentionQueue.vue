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
  approval: "bg-warning/15 text-warning",
  "needs-input": "bg-destructive/15 text-destructive",
  failed: "bg-destructive/20 text-destructive",
  review: "bg-info/15 text-info",
};

function onSelect(item: AttentionItem) {
  if (item.kind === "approval") emit("openApprovals");
  else emit("select", item.project, item.issueNumber);
}
</script>

<template>
  <div
    class="flex shrink-0 flex-col gap-1 rounded-lg border bg-card p-2"
    aria-label="Needs your attention"
  >
    <div class="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
      Needs you
      <span class="rounded-full bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
        {{ items.length }}
      </span>
    </div>
    <div
      v-for="item in items"
      :key="`${item.kind}:${item.approvalId ?? `${item.project}#${item.issueNumber}`}`"
      class="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-accent"
    >
      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 px-1 py-1 text-left" @click="onSelect(item)">
        <span class="shrink-0 rounded-full px-2 py-0.5 font-medium" :class="KIND_CLASS[item.kind]">
          {{ KIND_LABEL[item.kind] }}
        </span>
        <span class="shrink-0 font-medium text-foreground/80">{{ item.project }}#{{ item.issueNumber }}</span>
        <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ item.detail }}</span>
      </button>
      <a
        v-if="item.prUrl ?? item.url"
        :href="item.prUrl ?? item.url"
        target="_blank"
        rel="noopener"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        :title="item.prUrl ? 'Open PR' : 'Open issue'"
        :aria-label="item.prUrl ? 'Open PR' : 'Open issue'"
      >
        ↗
      </a>
      <span
        class="shrink-0 tabular-nums pr-1 text-muted-foreground"
        :title="`Waiting since ${new Date(item.since).toLocaleString()}`"
      >
        {{ formatWait(item.waitMs) }}
      </span>
    </div>
  </div>
</template>
