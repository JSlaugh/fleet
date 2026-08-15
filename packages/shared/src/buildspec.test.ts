import { describe, expect, it } from "vitest";
import { BuildSpecSchema, profileNames, selectSetupProfile, type BuildSpec } from "./buildspec.ts";

describe("BuildSpecSchema", () => {
  it("accepts a bare step list", () => {
    const parsed = BuildSpecSchema.parse({ setup: [{ name: "install", run: "pnpm install" }] });
    expect(parsed.setup).toEqual([{ name: "install", run: "pnpm install" }]);
  });

  it("accepts an empty step list (a type that needs no setup)", () => {
    expect(() => BuildSpecSchema.parse({ setup: [] })).not.toThrow();
  });

  it("accepts a profile map that includes a default profile", () => {
    const parsed = BuildSpecSchema.parse({
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        frontend: [
          { name: "install", run: "pnpm install" },
          { name: "build-storybook", run: "pnpm --filter web build-storybook" },
        ],
      },
    });
    expect(Object.keys(parsed.setup as Record<string, unknown>)).toEqual(["default", "frontend"]);
  });

  it("rejects a profile map with no default profile", () => {
    expect(() => BuildSpecSchema.parse({ setup: { frontend: [{ name: "install", run: "pnpm install" }] } })).toThrow();
  });

  it("rejects a step missing name or run", () => {
    expect(() => BuildSpecSchema.parse({ setup: [{ name: "install" }] })).toThrow();
    expect(() => BuildSpecSchema.parse({ setup: [{ run: "pnpm install" }] })).toThrow();
  });

  it("rejects a setup value that is neither a list nor a map", () => {
    expect(() => BuildSpecSchema.parse({ setup: "pnpm install" })).toThrow();
  });
});

describe("profileNames", () => {
  it("is empty for list-form specs", () => {
    const spec: BuildSpec = { setup: [{ name: "install", run: "pnpm install" }] };
    expect(profileNames(spec)).toEqual([]);
  });

  it("lists map-form profiles, excluding default", () => {
    const spec: BuildSpec = {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        frontend: [{ name: "install", run: "pnpm install" }],
        backend: [{ name: "install", run: "pnpm install" }],
      },
    };
    expect(profileNames(spec)).toEqual(["frontend", "backend"]);
  });
});

describe("selectSetupProfile", () => {
  const listSpec: BuildSpec = { setup: [{ name: "install", run: "pnpm install" }] };

  const mapSpec: BuildSpec = {
    setup: {
      default: [{ name: "install", run: "pnpm install" }],
      frontend: [
        { name: "install", run: "pnpm install" },
        { name: "build-storybook", run: "pnpm --filter web build-storybook" },
      ],
      backend: [
        { name: "install", run: "pnpm install" },
        { name: "test-db", run: "pnpm db:migrate:test" },
      ],
    },
  };

  it("list-form: always the sole profile, regardless of labels", () => {
    const selection = selectSetupProfile(listSpec, ["fleet:type:frontend"]);
    expect(selection).toEqual({ profile: "default", steps: listSpec.setup });
  });

  it("map-form: no type label uses default with no warning", () => {
    const selection = selectSetupProfile(mapSpec, ["fleet:ready"]);
    expect(selection.profile).toBe("default");
    expect(selection.steps).toBe((mapSpec.setup as Record<string, unknown>).default);
    expect(selection.warning).toBeUndefined();
  });

  it("map-form: a matching type label selects that profile", () => {
    const selection = selectSetupProfile(mapSpec, ["fleet:ready", "fleet:type:frontend"]);
    expect(selection.profile).toBe("frontend");
    expect(selection.steps.map((s) => s.name)).toEqual(["install", "build-storybook"]);
    expect(selection.warning).toBeUndefined();
  });

  it("map-form: an unknown type label falls back to default with a warning", () => {
    const selection = selectSetupProfile(mapSpec, ["fleet:type:mobile"]);
    expect(selection.profile).toBe("default");
    expect(selection.warning).toMatch(/no setup profile named "mobile"/);
  });

  it("map-form: multiple type labels pick the first match alphabetically and warn", () => {
    const selection = selectSetupProfile(mapSpec, ["fleet:type:frontend", "fleet:type:backend"]);
    expect(selection.profile).toBe("backend");
    expect(selection.warning).toMatch(/multiple fleet:type:\* labels/);
    expect(selection.warning).toMatch(/backend, frontend/);
  });

  it("map-form: multiple type labels where none match still falls back to default with both warnings", () => {
    const selection = selectSetupProfile(mapSpec, ["fleet:type:zeta", "fleet:type:mobile"]);
    expect(selection.profile).toBe("default");
    expect(selection.warning).toMatch(/multiple fleet:type:\* labels/);
    expect(selection.warning).toMatch(/no setup profile named "mobile"/);
  });
});
