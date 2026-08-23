<script setup lang="ts">
import type { AlertDialogCancelProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { computed } from "vue";
import { AlertDialogCancel } from "reka-ui";
import { cn } from "@/lib/utils.ts";
import { buttonVariants } from "@/components/ui/button/index.ts";

const props = defineProps<AlertDialogCancelProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
  const { class: _, ...rest } = props;
  return rest;
});
</script>

<template>
  <AlertDialogCancel v-bind="delegatedProps" :class="cn(buttonVariants({ variant: 'outline' }), props.class)">
    <slot />
  </AlertDialogCancel>
</template>
