<script setup lang="ts">
import { reactive, ref } from "vue";
import { parseWorkerQuestions, type PendingApproval } from "@fleet/shared";
import { formatTime } from "../lib/api.ts";

const props = defineProps<{
  approval: PendingApproval;
}>();

const emit = defineEmits<{
  answer: [message: string, done: (ok: boolean) => void];
  dismiss: [];
}>();

const questions = parseWorkerQuestions(props.approval.input);
const picks = reactive<Record<number, string[]>>({});
const other = reactive<Record<number, string>>({});
const submitted = ref(false);

function toggle(qIndex: number, label: string, multiSelect: boolean | undefined) {
  const current = picks[qIndex] ?? [];
  if (multiSelect) {
    picks[qIndex] = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
  } else {
    picks[qIndex] = current.includes(label) ? [] : [label];
  }
}

function composed(): string {
  return questions
    .map((q, i) => {
      const chosen = [...(picks[i] ?? [])];
      const free = other[i]?.trim();
      if (free) chosen.push(free);
      return `Q: ${q.question}\nA: ${chosen.length > 0 ? chosen.join("; ") : "(no answer)"}`;
    })
    .join("\n\n");
}

function submit() {
  if (submitted.value) return;
  submitted.value = true;
  emit("answer", composed(), (ok) => {
    if (!ok) submitted.value = false;
  });
}
</script>

<template>
  <article class="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950">
    <div class="flex items-center gap-2 text-xs">
      <span class="font-semibold text-neutral-900 dark:text-neutral-100">Worker question</span>
      <span class="text-neutral-500 dark:text-neutral-400">{{ approval.project }}#{{ approval.issueNumber }}</span>
      <span class="ml-auto text-neutral-400 dark:text-neutral-500">{{ formatTime(approval.createdAt) }}</span>
    </div>

    <fieldset v-for="(q, qIndex) in questions" :key="qIndex" class="mt-3">
      <legend class="text-xs font-medium text-neutral-800 dark:text-neutral-200">{{ q.question }}</legend>
      <div class="mt-1.5 space-y-1">
        <label
          v-for="option in q.options ?? []"
          :key="option.label"
          class="flex cursor-pointer items-start gap-2 rounded border bg-white p-2 text-xs dark:bg-neutral-900"
          :class="(picks[qIndex] ?? []).includes(option.label) ? 'border-blue-500 ring-1 ring-blue-500' : 'border-neutral-200 dark:border-neutral-700'"
        >
          <input
            :type="q.multiSelect ? 'checkbox' : 'radio'"
            :name="`${approval.id}-q${qIndex}`"
            :checked="(picks[qIndex] ?? []).includes(option.label)"
            class="mt-0.5"
            @change="toggle(qIndex, option.label, q.multiSelect)"
          />
          <span>
            <span class="font-medium text-neutral-900 dark:text-neutral-100">{{ option.label }}</span>
            <span v-if="option.description" class="block text-neutral-500 dark:text-neutral-400">{{ option.description }}</span>
          </span>
        </label>
        <label class="block">
          <span class="sr-only">Other answer for: {{ q.question }}</span>
          <input
            v-model="other[qIndex]"
            type="text"
            placeholder="Other…"
            class="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </label>
      </div>
    </fieldset>

    <div class="mt-3 flex gap-2">
      <button
        type="button"
        class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        :disabled="submitted"
        @click="submit"
      >
        {{ submitted ? "Sending…" : "Send answers" }}
      </button>
      <button
        type="button"
        class="rounded border border-neutral-300 px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-800"
        @click="emit('dismiss')"
      >
        Dismiss
      </button>
    </div>
  </article>
</template>
