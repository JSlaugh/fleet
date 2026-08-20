<script setup lang="ts">
import { computed } from "vue";
import type { TicketDiff } from "@fleet/shared";

const props = defineProps<{
  diff: TicketDiff;
}>();

type DiffLineKind = "add" | "remove" | "hunk" | "meta" | "context";

interface DiffLine {
  text: string;
  kind: DiffLineKind;
}

const META_PREFIXES = ["diff --git", "index ", "new file mode", "deleted file mode", "similarity index", "rename from", "rename to"];

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  if (line.startsWith("@@")) return "hunk";
  if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) return "meta";
  return "context";
}

const lines = computed<DiffLine[]>(() =>
  props.diff.diff.length === 0 ? [] : props.diff.diff.split("\n").map((text) => ({ text, kind: classifyLine(text) })),
);

const lineClass: Record<DiffLineKind, string> = {
  add: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  remove: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  hunk: "text-blue-600 dark:text-blue-400",
  meta: "text-neutral-400 dark:text-neutral-500",
  context: "text-neutral-600 dark:text-neutral-400",
};
</script>

<template>
  <div>
    <ul v-if="diff.files.length" class="mb-2 space-y-0.5 text-[11px]">
      <li
        v-for="file in diff.files"
        :key="file.path"
        class="flex items-center justify-between gap-2 rounded bg-neutral-50 px-2 py-1 font-mono dark:bg-neutral-800"
      >
        <span class="truncate text-neutral-700 dark:text-neutral-300">{{ file.path }}</span>
        <span class="shrink-0">
          <span class="text-emerald-600 dark:text-emerald-400">+{{ file.additions }}</span>
          <span class="ml-1 text-red-600 dark:text-red-400">-{{ file.deletions }}</span>
        </span>
      </li>
    </ul>

    <p v-if="diff.truncated" class="mb-2 text-[11px] text-amber-600 dark:text-amber-400">
      Diff truncated for display —
      <a :href="diff.prUrl" target="_blank" rel="noopener" class="underline">open on GitHub</a>
      for the full diff.
    </p>

    <p v-if="lines.length === 0" class="text-xs text-neutral-400 dark:text-neutral-500">No changes.</p>
    <pre
      v-else
      class="max-h-96 overflow-auto rounded bg-neutral-50 p-2 font-mono text-[10px] leading-relaxed dark:bg-neutral-900"
    ><span
      v-for="(line, index) in lines"
      :key="index"
      class="block whitespace-pre"
      :class="lineClass[line.kind]"
    >{{ line.text || " " }}</span></pre>
  </div>
</template>
