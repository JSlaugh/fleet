import { describe, expect, it } from "vitest";
import { CreateTicketSchema, bodyWithDependsOn, labelsForNewTicket, parseDependsOn } from "./ticket-intake.ts";

describe("CreateTicketSchema", () => {
  it("defaults ready to true", () => {
    const parsed = CreateTicketSchema.parse({ title: "Add a thing", body: "details" });
    expect(parsed.ready).toBe(true);
    expect(parsed.priority).toBeUndefined();
  });

  it("rejects an empty title", () => {
    expect(CreateTicketSchema.safeParse({ title: "", body: "details" }).success).toBe(false);
  });

  it("requires a body", () => {
    expect(CreateTicketSchema.safeParse({ title: "Add a thing" }).success).toBe(false);
  });

  it("accepts the three priority labels and nothing else", () => {
    for (const priority of ["fleet:p1", "fleet:p2", "fleet:p3"]) {
      expect(CreateTicketSchema.safeParse({ title: "t", body: "b", priority }).success).toBe(true);
    }
    expect(CreateTicketSchema.safeParse({ title: "t", body: "b", priority: "p1" }).success).toBe(false);
    expect(CreateTicketSchema.safeParse({ title: "t", body: "b", priority: "fleet:p0" }).success).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(CreateTicketSchema.safeParse(null).success).toBe(false);
    expect(CreateTicketSchema.safeParse("nope").success).toBe(false);
  });
});

describe("labelsForNewTicket", () => {
  it("labels a ready ticket fleet:ready", () => {
    expect(labelsForNewTicket({ title: "t", body: "b", ready: true })).toEqual(["fleet:ready"]);
  });

  it("adds the priority label when given", () => {
    expect(labelsForNewTicket({ title: "t", body: "b", ready: true, priority: "fleet:p1" })).toEqual([
      "fleet:ready",
      "fleet:p1",
    ]);
  });

  it("files into fleet:backlog instead of fleet:ready when ready is false, keeping the priority", () => {
    expect(labelsForNewTicket({ title: "t", body: "b", ready: false, priority: "fleet:p2" })).toEqual(["fleet:backlog", "fleet:p2"]);
    expect(labelsForNewTicket({ title: "t", body: "b", ready: false })).toEqual(["fleet:backlog"]);
  });
});

describe("parseDependsOn", () => {
  it("returns [] when there is no dependency line", () => {
    expect(parseDependsOn("Just a plain description.")).toEqual([]);
  });

  it("parses a single dependency", () => {
    expect(parseDependsOn("Depends-on: #12")).toEqual([12]);
  });

  it("parses comma-separated dependencies", () => {
    expect(parseDependsOn("Depends-on: #12, #14")).toEqual([12, 14]);
  });

  it("accepts mixed comma and space separators", () => {
    expect(parseDependsOn("Depends-on: #12 #14, #16")).toEqual([12, 14, 16]);
  });

  it("ignores malformed entries but keeps the valid ones", () => {
    expect(parseDependsOn("Depends-on: #12, banana, 14, #16")).toEqual([12, 16]);
  });

  it("is case-insensitive on the key", () => {
    expect(parseDependsOn("depends-on: #5")).toEqual([5]);
    expect(parseDependsOn("DEPENDS-ON: #5")).toEqual([5]);
  });

  it("finds the line anywhere in a multi-line body", () => {
    const body = ["## Problem", "Some description.", "", "Depends-on: #3", "", "## More"].join("\n");
    expect(parseDependsOn(body)).toEqual([3]);
  });

  it("dedupes repeated references", () => {
    expect(parseDependsOn("Depends-on: #4, #4")).toEqual([4]);
  });

  it("parses the issue-form-rendered section", () => {
    const body = ["### Depends on", "", "#12 #14", "", "### Priority", "", "P2 - default"].join("\n");
    expect(parseDependsOn(body)).toEqual([12, 14]);
  });

  it("is case-insensitive on the section heading", () => {
    const body = ["### depends on", "", "#5"].join("\n");
    expect(parseDependsOn(body)).toEqual([5]);
  });

  it("returns [] for an unfilled optional section", () => {
    const body = ["### Depends on", "", "_No response_", "", "### Priority", "", "P2 - default"].join("\n");
    expect(parseDependsOn(body)).toEqual([]);
  });

  it("unions dependencies from the line and section forms when both are present", () => {
    const body = ["Depends-on: #1", "", "### Depends on", "", "#2"].join("\n");
    expect(parseDependsOn(body)).toEqual([1, 2]);
  });
});

describe("bodyWithDependsOn", () => {
  it("leaves the body untouched when there are no dependencies", () => {
    expect(bodyWithDependsOn("details", undefined)).toBe("details");
    expect(bodyWithDependsOn("details", [])).toBe("details");
  });

  it("appends a Depends-on line for a single dependency", () => {
    expect(bodyWithDependsOn("details", [12])).toBe("details\n\nDepends-on: #12");
  });

  it("appends a Depends-on line listing every dependency", () => {
    expect(bodyWithDependsOn("details", [12, 14])).toBe("details\n\nDepends-on: #12, #14");
  });

  it("doesn't leave a leading blank line when the body is empty", () => {
    expect(bodyWithDependsOn("", [12])).toBe("Depends-on: #12");
  });
});
