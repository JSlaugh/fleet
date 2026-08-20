<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { PRIORITY_LABELS, SECTION_LABELS } from "@fleet/shared";
import { createTicket } from "../lib/api.ts";
import { composeTicketBody, missingTicketSections } from "../lib/ticketForm.ts";

const props = defineProps<{
  project: string;
}>();

const emit = defineEmits<{
  close: [];
  created: [];
}>();

const SECTION_KEYS = ["problem", "acceptance", "verification"] as const;

const title = ref("");
const sections = reactive({ problem: "", acceptance: "", verification: "" });
const priority = ref<(typeof PRIORITY_LABELS)[number] | "">("");
const ready = ref(true);
const dependsOnText = ref("");
const submitting = ref(false);
const error = ref<string>();
const result = ref<{ number: number; url: string }>();

const missing = computed(() => missingTicketSections(sections));

const dependsOnTokens = computed<string[]>(() =>
  dependsOnText.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const dependsOn = computed<number[]>(() =>
  dependsOnTokens.value
    .map((s) => Number(s.replace(/^#/, "")))
    .filter((n) => Number.isInteger(n) && n > 0),
);

/** Flags a partial typo (e.g. `12, abc`) too, not just a fully-unparseable field — a token silently dropped from `dependsOn` is as wrong as an empty result. */
const dependsOnInvalid = computed(() => dependsOn.value.length !== dependsOnTokens.value.length);

const canSubmit = computed(
  () => title.value.trim().length > 0 && missing.value.length === 0 && !dependsOnInvalid.value && !submitting.value,
);

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = undefined;
  try {
    result.value = await createTicket(props.project, {
      title: title.value.trim(),
      body: composeTicketBody(sections),
      priority: priority.value || undefined,
      ready: ready.value,
      dependsOn: dependsOn.value.length > 0 ? dependsOn.value : undefined,
    });
    emit("created");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

function resetForm() {
  title.value = "";
  sections.problem = "";
  sections.acceptance = "";
  sections.verification = "";
  priority.value = "";
  ready.value = true;
  dependsOnText.value = "";
  error.value = undefined;
  result.value = undefined;
}

/** Switching the target project mid-draft (via another chip's "+" while this panel is still open) would otherwise carry stale content into a submission filed under the new project. */
watch(() => props.project, resetForm);
</script>

<template>
  <aside
    class="flex w-[26rem] shrink-0 flex-col border-l border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900"
    :aria-label="`File a ticket in ${project}`"
  >
    <header class="flex items-center gap-2 border-b border-neutral-200 p-4 dark:border-neutral-700">
      <h2 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">New ticket</h2>
      <span class="text-xs text-neutral-400 dark:text-neutral-500">{{ project }}</span>
      <button
        type="button"
        class="ml-auto rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
        @click="emit('close')"
      >
        Close
      </button>
    </header>

    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <template v-if="result">
        <p class="rounded border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          Filed
          <a :href="result.url" target="_blank" rel="noopener" class="font-medium underline">#{{ result.number }}</a>
          in {{ project }}.
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            class="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            @click="resetForm"
          >
            File another
          </button>
          <button
            type="button"
            class="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
            @click="emit('close')"
          >
            Done
          </button>
        </div>
      </template>

      <form v-else class="space-y-3" @submit.prevent="submit">
        <label class="block">
          <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">Title</span>
          <input
            v-model="title"
            type="text"
            required
            class="mt-1 w-full rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
        </label>

        <label v-for="section in SECTION_KEYS" :key="section" class="block">
          <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">{{ SECTION_LABELS[section] }}</span>
          <textarea
            v-model="sections[section]"
            rows="4"
            class="mt-1 w-full rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          ></textarea>
        </label>

        <p v-if="missing.length > 0" class="text-xs text-amber-700 dark:text-amber-400">
          Missing: {{ missing.map((s) => SECTION_LABELS[s]).join(", ") }} — the same intake lint that gates claims.
        </p>

        <div class="flex gap-3">
          <label class="block flex-1">
            <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">Priority</span>
            <select
              v-model="priority"
              class="mt-1 w-full rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            >
              <option value="">None</option>
              <option v-for="p in PRIORITY_LABELS" :key="p" :value="p">{{ p.replace("fleet:", "") }}</option>
            </select>
          </label>
          <label class="flex items-center gap-1.5 self-end pb-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-300">
            <input v-model="ready" type="checkbox" />
            Ready
          </label>
        </div>

        <label class="block">
          <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">Depends on (issue numbers)</span>
          <input
            v-model="dependsOnText"
            type="text"
            placeholder="e.g. 12, 14"
            class="mt-1 w-full rounded border border-neutral-200 bg-white px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
          />
          <span v-if="dependsOnInvalid" class="mt-1 block text-xs text-red-600 dark:text-red-400">
            Enter a comma-separated list of issue numbers.
          </span>
        </label>

        <p v-if="error" class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>

        <button
          type="submit"
          class="w-full rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          :disabled="!canSubmit"
        >
          {{ submitting ? "Filing…" : "File ticket" }}
        </button>
      </form>
    </div>
  </aside>
</template>
