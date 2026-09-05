import { describe, expect, it } from "vitest";
import { CreateTicketSchema, labelsForNewTicket } from "./server.ts";

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
