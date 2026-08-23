<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { DigestResponse } from "@fleet/shared";
import { fetchDigest } from "../lib/api.ts";
import { usePanelFocus } from "../composables/usePanelFocus.ts";
import { formatCost } from "../lib/format.ts";

const emit = defineEmits<{ close: [] }>();

const panelRoot = ref<HTMLElement>();
usePanelFocus(panelRoot, () => emit("close"));

const digest = ref<DigestResponse>();
const loading = ref(false);
const error = ref<string>();

async function load() {
  loading.value = true;
  try {
    digest.value = await fetchDigest(24);
    error.value = undefined;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

const GATE_LABELS: Record<string, string> = {
  budget: "Budget",
  "work-hours": "Work-hours reserve",
  "plan-limit": "Plan usage limit",
};

function hasActivity(project: DigestResponse["projects"][number]): boolean {
  return (
    project.completed.length +
      project.autoMerged.length +
      project.blocked.length +
      project.failed.length +
      project.staleReleases.length >
    0
  );
}

onMounted(() => void load());
</script>

<template>
  <aside
    ref="panelRoot"
    tabindex="-1"
    class="flex w-[26rem] max-w-[85vw] max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:shadow-xl shrink-0 flex-col border-l bg-card"
    aria-label="Daily digest"
  >
    <header class="flex items-center gap-2 border-b p-4">
      <h2 class="text-sm font-semibold text-foreground">Digest</h2>
      <span v-if="digest" class="text-xs text-muted-foreground">trailing {{ digest.windowHours }}h</span>
      <button
        type="button"
        class="ml-auto rounded px-2 py-0.5 text-sm text-muted-foreground hover:bg-accent"
        @click="emit('close')"
      >
        Close
      </button>
    </header>
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
      <p v-else-if="loading && !digest" class="text-xs text-muted-foreground">Loading…</p>
      <template v-else-if="digest">
        <p
          v-if="digest.budget"
          class="rounded border px-2 py-1.5 text-xs text-muted-foreground"
        >
          Spend: {{ formatCost(digest.totalSpendUsd) || "$0.00" }} / {{ formatCost(digest.budget.budgetUsd) || "$0.00" }}
          ({{ digest.budget.windowHours }}h)
        </p>

        <p v-if="digest.projects.every((p) => !hasActivity(p))" class="text-xs text-muted-foreground">
          Nothing happened in the last {{ digest.windowHours }}h.
        </p>

        <section v-for="project in digest.projects.filter(hasActivity)" :key="project.project" class="space-y-2">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ project.project }}</h3>

          <ul v-if="project.completed.length" class="space-y-1 text-xs">
            <li v-for="t in project.completed" :key="`c-${t.issueNumber}`" class="flex items-center gap-1.5">
              <span class="rounded bg-info/15 px-1 text-info">review</span>
              <a :href="t.url" target="_blank" rel="noopener" class="truncate text-primary hover:underline"
                >#{{ t.issueNumber }} {{ t.title }}</a
              >
            </li>
          </ul>
          <ul v-if="project.autoMerged.length" class="space-y-1 text-xs">
            <li v-for="t in project.autoMerged" :key="`m-${t.issueNumber}`" class="flex items-center gap-1.5">
              <span class="rounded bg-success/15 px-1 text-success">merged</span>
              <a :href="t.url" target="_blank" rel="noopener" class="truncate text-primary hover:underline"
                >#{{ t.issueNumber }} {{ t.title }}</a
              >
            </li>
          </ul>
          <ul v-if="project.blocked.length" class="space-y-1 text-xs">
            <li v-for="t in project.blocked" :key="`b-${t.issueNumber}`" class="flex items-start gap-1.5">
              <span class="mt-px shrink-0 rounded bg-destructive/15 px-1 text-destructive">blocked</span>
              <span class="min-w-0">
                <a :href="t.url" target="_blank" rel="noopener" class="text-primary hover:underline"
                  >#{{ t.issueNumber }} {{ t.title }}</a
                >
                <span v-if="t.reason" class="block truncate text-muted-foreground">{{ t.reason }}</span>
              </span>
            </li>
          </ul>
          <ul v-if="project.failed.length" class="space-y-1 text-xs">
            <li v-for="t in project.failed" :key="`f-${t.issueNumber}`" class="flex items-start gap-1.5">
              <span class="mt-px shrink-0 rounded bg-warning/15 px-1 text-warning">failed</span>
              <span class="min-w-0">
                <a :href="t.url" target="_blank" rel="noopener" class="text-primary hover:underline"
                  >#{{ t.issueNumber }} {{ t.title }}</a
                >
                <span v-if="t.reason" class="block truncate text-muted-foreground">{{ t.reason }}</span>
              </span>
            </li>
          </ul>
          <ul v-if="project.staleReleases.length" class="space-y-1 text-xs">
            <li v-for="t in project.staleReleases" :key="`s-${t.issueNumber}`" class="flex items-center gap-1.5">
              <span class="rounded bg-muted px-1 text-muted-foreground">released</span>
              <a :href="t.url" target="_blank" rel="noopener" class="truncate text-primary hover:underline"
                >#{{ t.issueNumber }} {{ t.title }}</a
              >
            </li>
          </ul>
        </section>

        <section v-if="digest.gateHolds.length" class="space-y-1">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Gate holds</h3>
          <ul class="space-y-1 text-xs text-muted-foreground">
            <li v-for="(hold, i) in digest.gateHolds" :key="i">
              {{ GATE_LABELS[hold.gate] ?? hold.gate }}<template v-if="hold.project"> · {{ hold.project }}</template> —
              {{ hold.detail }}
            </li>
          </ul>
        </section>
      </template>
    </div>
  </aside>
</template>
