<script setup lang="ts">
import type { AlertDialogActionProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { AlertDialogAction } from "reka-ui";
import { cn } from "@/lib/utils.ts";
import { buttonVariants } from "@/components/ui/button/index.ts";

const props = defineProps<AlertDialogActionProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _, ...rest } = props;
  return rest;
});
</script>

<template>
  <AlertDialogAction v-bind="delegatedProps" :class="cn(buttonVariants(), props.class)">
    <slot />
  </AlertDialogAction>
</template>
