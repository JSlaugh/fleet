<script setup lang="ts">
import { reactive, ref } from "vue";
import { parseWorkerQuestions, type PendingApproval } from "@fleet/shared";
import { formatTime } from "../lib/format.ts";

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
  <article class="rounded-lg border border-info/30 bg-info/10 p-3">
    <div class="flex items-center gap-2 text-xs">
      <span class="font-semibold text-foreground">Worker question</span>
      <span class="text-muted-foreground">{{ approval.project }}#{{ approval.issueNumber }}</span>
      <span class="ml-auto text-muted-foreground">{{ formatTime(approval.createdAt) }}</span>
    </div>

    <fieldset v-for="(q, qIndex) in questions" :key="qIndex" class="mt-3">
      <legend class="text-xs font-medium text-foreground">{{ q.question }}</legend>
      <div class="mt-1.5 space-y-1">
        <label
          v-for="option in q.options ?? []"
          :key="option.label"
          class="flex cursor-pointer items-start gap-2 rounded border bg-card p-2 text-xs"
          :class="(picks[qIndex] ?? []).includes(option.label) ? 'border-primary ring-1 ring-primary' : 'border-border'"
        >
          <input
            :type="q.multiSelect ? 'checkbox' : 'radio'"
            :name="`${approval.id}-q${qIndex}`"
            :checked="(picks[qIndex] ?? []).includes(option.label)"
            class="mt-0.5"
            @change="toggle(qIndex, option.label, q.multiSelect)"
          />
          <span>
            <span class="font-medium text-foreground">{{ option.label }}</span>
            <span v-if="option.description" class="block text-muted-foreground">{{ option.description }}</span>
          </span>
        </label>
        <label class="block">
          <span class="sr-only">Other answer for: {{ q.question }}</span>
          <input
            v-model="other[qIndex]"
            type="text"
            placeholder="Other…"
            class="w-full rounded border bg-card px-2 py-1 text-xs"
          />
        </label>
      </div>
    </fieldset>

    <div class="mt-3 flex gap-2">
      <button
        type="button"
        class="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        :disabled="submitted"
        @click="submit"
      >
        {{ submitted ? "Sending…" : "Send answers" }}
      </button>
      <button
        type="button"
        class="rounded border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
        @click="emit('dismiss')"
      >
        Dismiss
      </button>
    </div>
  </article>
</template>
