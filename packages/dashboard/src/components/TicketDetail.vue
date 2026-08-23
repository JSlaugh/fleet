<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type {
  ApprovalLatencyStats,
  BoardTicket,
  ClosedTicketRecord,
  TicketDetail,
  TicketDiff,
  TicketReport,
  TicketReportFinding,
  TicketTranscript,
} from "@fleet/shared";
import { shortModelName } from "@fleet/shared";
import {
  acceptPlan,
  fetchTicket,
  fetchTicketDiff,
  fetchTicketReport,
  fetchTicketTranscript,
  restartTicket,
  sendReply,
} from "../lib/api.ts";
import { formatCost, formatDuration, formatTime, formatTokens } from "../lib/format.ts";
import { machineReviewBadgeClass } from "../lib/statusColors.ts";
import { usePanelFocus } from "../composables/usePanelFocus.ts";
import { usePolledResource } from "../composables/usePolledResource.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog/index.ts";
import PrDiff from "./PrDiff.vue";

function formatApprovalWait(latency: ApprovalLatencyStats | undefined): string {
  if (!latency || latency.count === 0) return "—";
  const meanMs = latency.totalWaitMs / latency.count;
  return `${formatDuration(meanMs)} / ${formatDuration(latency.maxWaitMs)}`;
}

function findingLocation(finding: TicketReportFinding): string {
  if (finding.ticketIndex !== undefined) return `ticket [${finding.ticketIndex}]`;
  if (finding.file === undefined) return "decomposition";
  return finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
}

const props = defineProps<{
  ticket: BoardTicket;
}>();

const emit = defineEmits<{
  close: [];
}>();

const panelRoot = ref<HTMLElement>();
usePanelFocus(panelRoot, () => emit("close"));

const detail = ref<TicketDetail>();
const report = ref<TicketReport>();
const transcript = ref<TicketTranscript>();
const diff = ref<TicketDiff>();
const diffError = ref<string>();
const error = ref<string>();
const reply = ref("");
const sending = ref(false);
const replyStatus = ref<string>();
const restarting = ref(false);
const restartStatus = ref<string>();
/** The diff only changes when new commits land, so re-fetching it every 3s poll tick (like the journal) would be a wasted `gh` shell-out — this tracks what's already been fetched so a refetch only fires when `lastActivityAt` actually moves. */
let lastDiffFetchKey: string | undefined;
/** The archived transcript is immutable once present (only copied in after worktree cleanup), so it gets the same fetch-key treatment: once loaded it's never refetched, and while it 404s a retry only fires when the record's state actually moves. */
let lastTranscriptFetchKey: string | undefined;

const accepting = ref(false);
const acceptStatus = ref<string>();

const closedRecord = computed<ClosedTicketRecord | undefined>(() =>
  detail.value?.record && "prState" in detail.value.record ? (detail.value.record as ClosedTicketRecord) : undefined,
);

const canReply = computed(() => detail.value?.canReply ?? false);
const canRestart = computed(() => detail.value?.canRestart ?? false);
const canAcceptPlan = computed(() => props.ticket.isPlan && detail.value?.record?.status === "review");

const reportToolNames = computed(() => Object.keys(report.value?.toolCounts ?? {}).sort());
const reportIsEmpty = computed(
  () => !report.value || (reportToolNames.value.length === 0 && report.value.segments.length === 0),
);

async function acceptPlanNow() {
  if (accepting.value) return;
  accepting.value = true;
  acceptStatus.value = undefined;
  try {
    await acceptPlan(props.ticket.project, props.ticket.issueNumber);
    acceptStatus.value = "Accepted — issue closed.";
    void refresh();
  } catch (err) {
    acceptStatus.value = err instanceof Error ? err.message : String(err);
  } finally {
    accepting.value = false;
  }
}

const restartBranch = computed(() => detail.value?.record?.branch ?? `fleet/${props.ticket.issueNumber}`);

async function restartNow() {
  if (restarting.value) return;
  restarting.value = true;
  restartStatus.value = undefined;
  try {
    await restartTicket(props.ticket.project, props.ticket.issueNumber);
    restartStatus.value = "Restarted — waiting for a fresh session.";
    void refresh();
  } catch (err) {
    restartStatus.value = err instanceof Error ? err.message : String(err);
  } finally {
    restarting.value = false;
  }
}

async function submitReply() {
  const message = reply.value.trim();
  if (!message || sending.value) return;
  sending.value = true;
  replyStatus.value = undefined;
  try {
    const { mode } = await sendReply(props.ticket.project, props.ticket.issueNumber, message);
    replyStatus.value = mode === "steered" ? "Sent into the live session." : "Session resumed with your reply.";
    reply.value = "";
    void refresh();
  } catch (err) {
    replyStatus.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

async function load(isStale: () => boolean) {
  // Detail, report, and transcript are independent — only the diff below needs
  // the detail's prUrl, so these three start together.
  const loadDetail = async () => {
    try {
      const fetched = await fetchTicket(props.ticket.project, props.ticket.issueNumber);
      if (isStale()) return;
      detail.value = fetched;
      error.value = undefined;
    } catch (err) {
      if (isStale()) return;
      error.value = err instanceof Error ? err.message : String(err);
    }
  };
  const loadReport = async () => {
    try {
      const fetched = await fetchTicketReport(props.ticket.project, props.ticket.issueNumber);
      if (isStale()) return;
      report.value = fetched;
    } catch {
      if (isStale()) return;
      report.value = undefined;
    }
  };
  const loadTranscript = async () => {
    if (transcript.value) return;
    // Keyed off the previous tick's detail — a state move (or the very first
    // load, when detail is still empty) permits one attempt; a quiet tick doesn't.
    const key = `${props.ticket.project}#${props.ticket.issueNumber}|${detail.value?.record?.status ?? ""}|${detail.value?.record?.lastActivityAt ?? ""}`;
    if (key === lastTranscriptFetchKey) return;
    lastTranscriptFetchKey = key;
    try {
      const fetched = await fetchTicketTranscript(props.ticket.project, props.ticket.issueNumber);
      if (isStale()) return;
      transcript.value = fetched;
    } catch {
      // 404 — not archived yet; the next state move retries.
    }
  };
  await Promise.all([loadDetail(), loadReport(), loadTranscript()]);
  if (isStale()) return;
  const prUrl = detail.value?.record?.prUrl;
  if (prUrl) {
    const key = `${props.ticket.project}#${props.ticket.issueNumber}|${prUrl}|${detail.value?.record?.lastActivityAt ?? ""}`;
    if (key !== lastDiffFetchKey) {
      lastDiffFetchKey = key;
      try {
        const fetched = await fetchTicketDiff(props.ticket.project, props.ticket.issueNumber);
        if (isStale()) return;
        diff.value = fetched;
        diffError.value = undefined;
      } catch (err) {
        if (isStale()) return;
        diff.value = undefined;
        diffError.value = err instanceof Error ? err.message : String(err);
      }
    }
  } else {
    lastDiffFetchKey = undefined;
    diff.value = undefined;
    diffError.value = undefined;
  }
}

// Done tickets change rarely (a ClosedTicketRecord is effectively final), so
// their poll backs off to 30s; live tickets keep the 3s cadence. The immediate
// load on mount happens either way.
const { refresh } = usePolledResource(load, () =>
  closedRecord.value || props.ticket.status === "done" ? 30_000 : 3_000,
);

// The panel instance is reused when another card is selected (no :key in
// App.vue), so the fetch-once state has to reset by hand or the previous
// ticket's transcript/diff would be pinned under the new one.
watch(
  () => `${props.ticket.project}#${props.ticket.issueNumber}`,
  () => {
    detail.value = undefined;
    report.value = undefined;
    transcript.value = undefined;
    diff.value = undefined;
    diffError.value = undefined;
    lastDiffFetchKey = undefined;
    lastTranscriptFetchKey = undefined;
    void refresh();
  },
);
</script>

<template>
  <aside
    ref="panelRoot"
    tabindex="-1"
    class="flex w-[30rem] shrink-0 flex-col border-l border-neutral-200 bg-white outline-none dark:border-neutral-700 dark:bg-neutral-900"
    aria-label="Ticket detail"
  >
    <header class="border-b border-neutral-200 p-4 dark:border-neutral-700">
      <div class="flex items-start gap-2">
        <h2 class="min-w-0 flex-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {{ ticket.title }}
        </h2>
        <AlertDialog v-if="canAcceptPlan">
          <AlertDialogTrigger as-child>
            <button
              type="button"
              class="rounded border border-green-300 px-2 py-0.5 text-xs font-medium text-green-700 hover:bg-green-50 disabled:opacity-50 dark:border-green-800 dark:text-green-400 dark:hover:bg-green-950"
              :disabled="accepting"
              title="Close this plan epic's issue — the worktree and branch are cleaned up on the next poll cycle"
            >
              {{ accepting ? "Accepting…" : "Accept plan" }}
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Accept plan {{ ticket.project }}#{{ ticket.issueNumber }}?</AlertDialogTitle>
              <AlertDialogDescription>
                This closes the epic issue. Its worktree and branch are cleaned up on the daemon's next poll cycle.
                Child tickets are not affected — release each with its own fleet:ready label.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction @click="acceptPlanNow">Accept plan</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog v-if="canRestart">
          <AlertDialogTrigger as-child>
            <button
              type="button"
              class="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
              :disabled="restarting"
              title="Terminate the session and re-run this ticket from scratch, discarding its branch work"
            >
              {{ restarting ? "Restarting…" : "Restart" }}
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restart {{ ticket.project }}#{{ ticket.issueNumber }}?</AlertDialogTitle>
              <AlertDialogDescription>
                This terminates the current session and discards its work: the branch {{ restartBranch }} and its
                worktree are deleted and recreated from scratch, so any commits the worker made are lost.
                The ticket goes back to fleet:ready and a brand-new session picks it up on the next poll cycle.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction @click="restartNow">Restart</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <button
          type="button"
          class="rounded px-2 py-0.5 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          @click="emit('close')"
        >
          Close
        </button>
      </div>
      <p v-if="acceptStatus" class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{{ acceptStatus }}</p>
      <p v-if="restartStatus" class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{{ restartStatus }}</p>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        <a :href="ticket.url" target="_blank" rel="noopener" class="text-blue-600 hover:underline dark:text-blue-400">
          {{ ticket.project }}#{{ ticket.issueNumber }}
        </a>
        <a
          v-if="detail?.record?.prUrl"
          :href="detail.record.prUrl"
          target="_blank"
          rel="noopener"
          class="text-blue-600 hover:underline dark:text-blue-400"
        >
          Pull request
        </a>
        <span v-if="detail?.record?.branch">branch {{ detail.record.branch }}</span>
        <span v-if="detail?.record?.model">model {{ shortModelName(detail.record.model) }}</span>
        <span v-if="formatCost(detail?.record?.costUsd)">{{ formatCost(detail?.record?.costUsd) }}</span>
        <span v-if="detail?.record?.lastActivityAt">active {{ formatTime(detail.record.lastActivityAt) }}</span>
      </div>
      <dl
        v-if="detail?.record?.modelUsage"
        class="mt-2 space-y-0.5 text-xs text-neutral-500 dark:text-neutral-400"
      >
        <div v-for="(usage, model) in detail.record.modelUsage" :key="model" class="flex gap-2">
          <dt class="font-medium text-neutral-600 dark:text-neutral-300">{{ shortModelName(String(model)) }}</dt>
          <dd>{{ formatTokens(usage.inputTokens) }} in / {{ formatTokens(usage.outputTokens) }} out · {{ formatCost(usage.costUsd) || "&lt;$0.01" }}</dd>
        </div>
      </dl>
      <dl
        v-if="closedRecord"
        class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400"
      >
        <div v-if="closedRecord.timeToMergeMs !== undefined" class="flex gap-1">
          <dt class="font-medium text-neutral-600 dark:text-neutral-300">Time to merge</dt>
          <dd>{{ formatDuration(closedRecord.timeToMergeMs) }}</dd>
        </div>
        <div v-if="closedRecord.reviewRounds !== undefined" class="flex gap-1">
          <dt class="font-medium text-neutral-600 dark:text-neutral-300">Review rounds</dt>
          <dd>{{ closedRecord.reviewRounds }}</dd>
        </div>
        <div v-if="closedRecord.reviewCommentCount !== undefined" class="flex gap-1">
          <dt class="font-medium text-neutral-600 dark:text-neutral-300">Review comments</dt>
          <dd>{{ closedRecord.reviewCommentCount }}</dd>
        </div>
        <div v-if="closedRecord.humanPushedAfterOpen !== undefined" class="flex gap-1">
          <dt class="font-medium text-neutral-600 dark:text-neutral-300">Human rework</dt>
          <dd>{{ closedRecord.humanPushedAfterOpen ? "yes" : "no" }}</dd>
        </div>
      </dl>
      <p v-if="detail?.record?.lastSummary" class="mt-3 max-h-48 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
        {{ detail.record.lastSummary }}
      </p>
      <p v-if="detail?.record?.sessionId" class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        Resume locally:
        <code class="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">claude --resume {{ detail.record.sessionId }}</code>
      </p>
    </header>

    <form
      v-if="canReply"
      class="border-b border-neutral-200 p-4 dark:border-neutral-700"
      @submit.prevent="submitReply"
    >
      <label class="block">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          Reply to worker
        </span>
        <textarea
          v-model="reply"
          rows="3"
          class="w-full resize-y rounded border border-neutral-300 bg-white p-2 text-xs text-neutral-900 focus:border-blue-500 focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
          :placeholder="detail?.record?.status === 'needs-input' ? 'Answer the worker\'s question…' : 'Steer the running session…'"
        ></textarea>
      </label>
      <div class="mt-2 flex items-center gap-3">
        <button
          type="submit"
          class="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="sending || reply.trim().length === 0"
        >
          {{ sending ? "Sending…" : "Send" }}
        </button>
        <span v-if="replyStatus" class="text-xs text-neutral-500 dark:text-neutral-400">{{ replyStatus }}</span>
      </div>
    </form>

    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <section v-if="detail?.record?.prUrl" class="mb-4">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          Diff
        </h3>
        <PrDiff v-if="diff" :diff="diff" />
        <p v-else-if="diffError" class="text-xs text-red-600 dark:text-red-400">{{ diffError }}</p>
        <p v-else class="text-xs text-neutral-400 dark:text-neutral-500">Loading diff…</p>
      </section>

      <section class="mb-4">
        <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          Operation report
        </h3>
        <p v-if="reportIsEmpty" class="text-xs text-neutral-400 dark:text-neutral-500">
          No session activity recorded yet.
        </p>
        <div v-else class="space-y-3">
          <dl class="grid grid-cols-3 gap-2 text-xs">
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Tool calls</dt>
              <dd class="font-semibold text-neutral-700 dark:text-neutral-300">{{ report?.totals.toolCalls }}</dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Errors</dt>
              <dd
                class="font-semibold"
                :class="
                  (report?.totals.errors ?? 0) > 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-neutral-700 dark:text-neutral-300'
                "
              >
                {{ report?.totals.errors }}
              </dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Turns</dt>
              <dd class="font-semibold text-neutral-700 dark:text-neutral-300">{{ report?.totals.turns }}</dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Wall time</dt>
              <dd class="font-semibold text-neutral-700 dark:text-neutral-300">
                {{ formatDuration(report?.totals.durationMs) }}
              </dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Cost</dt>
              <dd class="font-semibold text-neutral-700 dark:text-neutral-300">
                {{ formatCost(report?.totals.costUsd) || "&lt;$0.01" }}
              </dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Bash denied</dt>
              <dd
                class="font-semibold"
                :class="
                  (report?.bashDeniedCount ?? 0) > 0
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-neutral-700 dark:text-neutral-300'
                "
              >
                {{ report?.bashDeniedCount ?? 0 }}
              </dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Approval wait (mean/max)</dt>
              <dd class="font-semibold text-neutral-700 dark:text-neutral-300">
                {{ formatApprovalWait(report?.approvalLatency) }}
              </dd>
            </div>
            <div class="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-800">
              <dt class="text-neutral-400 dark:text-neutral-500">Cache read/write</dt>
              <dd class="font-semibold text-neutral-700 dark:text-neutral-300">
                {{ formatTokens(report?.cacheReadTokens ?? 0) }} / {{ formatTokens(report?.cacheCreationTokens ?? 0) }}
              </dd>
            </div>
          </dl>

          <div v-if="report?.machineReview" class="rounded bg-neutral-50 px-2 py-1.5 text-[11px] dark:bg-neutral-800">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-neutral-700 dark:text-neutral-300">
                {{ report.machineReview.kind === "plan" ? "Plan review" : "Machine review" }}
              </span>
              <span
                class="rounded px-1.5 py-0.5 font-medium"
                :class="machineReviewBadgeClass(report.machineReview.outcome)"
              >
                {{ report.machineReview.outcome }}
              </span>
              <span v-if="report.machineReview.model" class="text-neutral-400 dark:text-neutral-500">
                {{ shortModelName(report.machineReview.model) }}
              </span>
            </div>
            <p v-if="report.machineReview.errorSubtype" class="mt-1 text-neutral-500 dark:text-neutral-400">
              {{ report.machineReview.errorSubtype }}
            </p>
            <ul v-if="report.machineReview.findings.length" class="mt-1 space-y-0.5">
              <li v-for="(finding, index) in report.machineReview.findings" :key="index" class="text-neutral-600 dark:text-neutral-400">
                <span class="font-medium text-neutral-700 dark:text-neutral-300">{{ findingLocation(finding) }}</span>
                <template v-if="finding.severity"> ({{ finding.severity }})</template>
                <template v-if="finding.summary">: {{ finding.summary }}</template>
              </li>
            </ul>
          </div>

          <table v-if="reportToolNames.length" class="w-full text-left text-[11px]">
            <thead>
              <tr class="text-neutral-400 dark:text-neutral-500">
                <th class="pb-1 font-medium">Tool</th>
                <th class="pb-1 text-right font-medium">Calls</th>
                <th class="pb-1 text-right font-medium">Errors</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="name in reportToolNames"
                :key="name"
                class="border-t border-neutral-100 dark:border-neutral-800"
              >
                <td class="py-1 text-neutral-700 dark:text-neutral-300">{{ name }}</td>
                <td class="py-1 text-right text-neutral-600 dark:text-neutral-400">
                  {{ report?.toolCounts[name] }}
                </td>
                <td
                  class="py-1 text-right"
                  :class="
                    (report?.toolErrorCounts[name] ?? 0) > 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-neutral-600 dark:text-neutral-400'
                  "
                >
                  {{ report?.toolErrorCounts[name] ?? 0 }}
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="report && report.segments.length > 0" class="space-y-1">
            <h4 class="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              Segments
            </h4>
            <ol class="space-y-1">
              <li
                v-for="(segment, index) in report.segments"
                :key="index"
                class="flex items-center justify-between gap-2 rounded bg-neutral-50 px-2 py-1 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
              >
                <span class="font-medium text-neutral-700 dark:text-neutral-300">Segment {{ index + 1 }}</span>
                <span>{{ segment.numTurns ?? "–" }} turns</span>
                <span>{{ formatDuration(segment.durationMs) }}</span>
                <span>{{ formatCost(segment.costUsd) || "&lt;$0.01" }}</span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        Session activity
      </h3>
      <p v-if="error" class="text-xs text-red-600 dark:text-red-400">{{ error }}</p>
      <p v-else-if="!detail || detail.journal.length === 0" class="text-xs text-neutral-400 dark:text-neutral-500">
        No session activity recorded yet.
      </p>
      <ol v-else class="space-y-1.5">
        <li
          v-for="(entry, index) in detail.journal"
          :key="index"
          class="rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          <span class="text-neutral-400 dark:text-neutral-500">{{ formatTime(entry.ts) }}</span>
          <span class="ml-2 font-semibold">{{ entry.type }}<template v-if="entry.subtype">/{{ entry.subtype }}</template></span>
          <span v-if="entry.tools?.length" class="ml-2 text-blue-700 dark:text-blue-400">{{ entry.tools.join(", ") }}</span>
          <p v-if="entry.text" class="mt-0.5 whitespace-pre-wrap break-words text-neutral-600 dark:text-neutral-400">
            {{ entry.text }}
          </p>
          <p v-if="entry.thinking" class="mt-0.5 whitespace-pre-wrap break-words italic text-neutral-400 dark:text-neutral-500">
            {{ entry.thinking }}
          </p>
        </li>
      </ol>

      <h3 class="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
        Archived transcript
      </h3>
      <p v-if="!transcript?.files?.length" class="text-xs text-neutral-400 dark:text-neutral-500">
        No archived transcript yet — transcripts are copied in once the ticket's worktree is cleaned up.
      </p>
      <div v-else class="space-y-2">
        <details
          v-for="file in transcript.files"
          :key="file.name"
          class="rounded bg-neutral-50 dark:bg-neutral-800"
        >
          <summary class="cursor-pointer px-2 py-1 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
            {{ file.name }}
          </summary>
          <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-[10px] leading-relaxed text-neutral-600 dark:text-neutral-400">{{ file.content }}</pre>
        </details>
      </div>
    </div>
  </aside>
</template>
