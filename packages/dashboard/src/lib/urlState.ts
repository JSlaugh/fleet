export interface UrlTicketRef {
  project: string;
  issueNumber: number;
}

export interface UrlState {
  view: "board" | "history";
  project?: string;
  ticket?: UrlTicketRef;
}

export const DEFAULT_URL_STATE: UrlState = { view: "board" };

/** Parse a location.search string; unknown params and malformed values fall back to defaults. */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  return {
    view: params.get("view") === "history" ? "history" : "board",
    project: params.get("project") || undefined,
    ticket: parseTicketParam(params.get("ticket")),
  };
}

// The ticket param carries "<project>:<issueNumber>" — the selected ticket's
// project is independent of the project filter param.
function parseTicketParam(raw: string | null): UrlTicketRef | undefined {
  if (!raw) return undefined;
  const sep = raw.lastIndexOf(":");
  if (sep <= 0) return undefined;
  const issueNumber = Number(raw.slice(sep + 1));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return undefined;
  return { project: raw.slice(0, sep), issueNumber };
}

/** Serialize to a query string ("?…"), or "" when everything is at its default. */
export function serializeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.view !== "board") params.set("view", state.view);
  if (state.project) params.set("project", state.project);
  if (state.ticket) params.set("ticket", `${state.ticket.project}:${state.ticket.issueNumber}`);
  const query = params.toString();
  return query ? `?${query}` : "";
}
