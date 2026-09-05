<script setup lang="ts">
import { computed } from "vue";
import { PRIORITY_LABELS, shortModelName, type BoardTicket, type ClosedTicketRecord } from "@fleet/shared";
import { formatCost } from "../lib/format.ts";
import { Badge } from "@/components/ui/badge/index.ts";
import { Card } from "@/components/ui/card/index.ts";

const props = defineProps<{
  ticket: BoardTicket;
  selected: boolean;
  pendingApprovals?: number;
}>();

const emit = defineEmits<{
  select: [];
  setPriority: [priority: string | null];
  markReady: [];
}>();

function onPriorityChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  emit("setPriority", value === "" ? null : value);
}

const priorityShort = (label: string) => label.replace("fleet:", "");

const isDone = computed(() => props.ticket.status === "done");
const isBacklog = computed(() => props.ticket.status === "backlog");

const closedRecord = computed(() => (isDone.value ? (props.ticket.record as ClosedTicketRecord | undefined) : undefined));

const blurb = computed(() => {
  const record = props.ticket.record;
  if (record?.sessionLive && record.lastActivityNote) return record.lastActivityNote;
  return record?.lastSummary;
});
</script>

<template>
  <Card
    as="article"
    class="cursor-pointer gap-0 rounded-lg p-3 text-left transition hover:border-muted-foreground/50"
    :class="[
      selected ? 'border-primary ring-1 ring-primary' : '',
      ticket.blockedBy?.length ? 'opacity-50' : '',
    ]"
    @click="emit('select')"
  >
    <div class="flex items-start gap-2">
      <h3 class="min-w-0 flex-1 text-sm font-medium text-card-foreground">
        {{ ticket.title }}
      </h3>
      <button
        v-if="isBacklog"
        type="button"
        class="rounded border border-success/40 px-1.5 py-0.5 text-xs font-medium text-success hover:bg-success/10"
        title="Release this ticket: fleet:backlog → fleet:ready, so the next poll cycle can claim it"
        @click.stop="emit('markReady')"
      >
        Ready
      </button>
      <select
        v-if="!isDone"
        :aria-label="`Priority for ${ticket.project} issue ${ticket.issueNumber}`"
        class="rounded border bg-secondary px-1 py-0.5 text-xs text-secondary-foreground"
        :value="ticket.priority ?? ''"
        @click.stop
        @change="onPriorityChange"
      >
        <option value="">—</option>
        <option v-for="p in PRIORITY_LABELS" :key="p" :value="p">{{ priorityShort(p) }}</option>
      </select>
    </div>
    <p
      v-if="blurb"
      class="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground"
    >
      {{ blurb }}
    </p>
    <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
      <Badge
        v-if="isDone"
        as="a"
        variant="muted"
        :href="ticket.url"
        target="_blank"
        rel="noopener"
        class="hover:underline"
        @click.stop
      >
        {{ ticket.project }}#{{ ticket.issueNumber }}
      </Badge>
      <Badge v-else variant="muted">
        {{ ticket.project }}#{{ ticket.issueNumber }}
      </Badge>
      <Badge v-if="ticket.type" variant="highlight">
        {{ ticket.type }}
      </Badge>
      <Badge v-if="ticket.isPlan" variant="highlight">
        plan
      </Badge>
      <Badge
        v-if="ticket.epicProgress"
        variant="highlight"
        :title="`${ticket.epicProgress.closed} of ${ticket.epicProgress.total} child tickets closed`"
      >
        {{ ticket.epicProgress.closed }}/{{ ticket.epicProgress.total }} children
      </Badge>
      <Badge v-if="ticket.epicNumber" variant="muted" :title="`Part of epic #${ticket.epicNumber}`">
        epic #{{ ticket.epicNumber }}
      </Badge>
      <Badge v-if="closedRecord" variant="muted">
        {{ closedRecord.prState === "MERGED" ? "merged" : "closed" }} {{ new Date(closedRecord.closedAt).toLocaleString() }}
      </Badge>
      <Badge
        v-if="closedRecord?.prUrl"
        as="a"
        variant="info"
        :href="closedRecord.prUrl"
        target="_blank"
        rel="noopener"
        class="hover:underline"
        @click.stop
      >
        PR
      </Badge>
      <Badge v-if="ticket.record?.sessionLive" variant="success">
        live
      </Badge>
      <Badge v-if="pendingApprovals" variant="warning">
        {{ pendingApprovals }} approval{{ pendingApprovals === 1 ? "" : "s" }}
      </Badge>
      <Badge v-if="ticket.record?.status === 'stalled'" variant="warning">
        stalled
      </Badge>
      <Badge v-if="ticket.record?.status === 'restarting'" variant="info">
        restarting
      </Badge>
      <Badge v-if="ticket.record?.status === 'failed'" variant="destructive">
        failed
      </Badge>
      <Badge v-if="ticket.blockedBy?.length" variant="muted">
        waiting on #{{ ticket.blockedBy.join(", #") }}
      </Badge>
      <Badge v-if="shortModelName(ticket.record?.model)" variant="highlight">
        {{ shortModelName(ticket.record?.model) }}
      </Badge>
      <span v-if="formatCost(ticket.record?.costUsd)" class="ml-auto text-muted-foreground">
        {{ formatCost(ticket.record?.costUsd) }}
      </span>
    </div>
  </Card>
</template>
