<script setup lang="ts">
defineProps<{
  title: string;
  count: number;
  accent: string;
}>();
</script>

<template>
  <section class="flex min-h-0 w-80 shrink-0 flex-col rounded-xl bg-neutral-100 dark:bg-neutral-900">
    <header class="flex items-center gap-2 px-4 py-3">
      <span class="size-2 rounded-full" :class="accent" aria-hidden="true"></span>
      <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">{{ title }}</h2>
      <span class="ml-auto rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
        {{ count }}
      </span>
    </header>
    <div class="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
      <slot />
      <p v-if="count === 0" class="px-2 py-6 text-center text-xs text-neutral-400 dark:text-neutral-600">Empty</p>
    </div>
  </section>
</template>
