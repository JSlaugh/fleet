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
  add: "bg-success/10 text-success",
  remove: "bg-destructive/10 text-destructive",
  hunk: "text-primary",
  meta: "text-muted-foreground",
  context: "text-muted-foreground",
};
</script>

<template>
  <div>
    <ul v-if="diff.files.length" class="mb-2 space-y-0.5 text-[11px]">
      <li
        v-for="file in diff.files"
        :key="file.path"
        class="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1 font-mono"
      >
        <span class="truncate text-foreground/80">{{ file.path }}</span>
        <span class="shrink-0">
          <span class="text-success">+{{ file.additions }}</span>
          <span class="ml-1 text-destructive">-{{ file.deletions }}</span>
        </span>
      </li>
    </ul>

    <p v-if="diff.truncated" class="mb-2 text-[11px] text-warning">
      Diff truncated for display —
      <a :href="diff.prUrl" target="_blank" rel="noopener" class="underline">open on GitHub</a>
      for the full diff.
    </p>

    <p v-if="lines.length === 0" class="text-xs text-muted-foreground">No changes.</p>
    <pre
      v-else
      class="max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-[10px] leading-relaxed"
    ><span
      v-for="(line, index) in lines"
      :key="index"
      class="block whitespace-pre"
      :class="lineClass[line.kind]"
    >{{ line.text || " " }}</span></pre>
  </div>
</template>
