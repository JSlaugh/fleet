import { describe, expect, it } from "vitest";
import { BuildSpecSchema, checklistForType, contractForType, profileNames, selectSetupProfile, type BuildSpec } from "./buildspec.ts";

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

  it("accepts a profile written as { setup, contract } alongside bare-array profiles", () => {
    const parsed = BuildSpecSchema.parse({
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        backend: {
          setup: [{ name: "install", run: "pnpm install" }],
          contract: "Run the backend test suite before declaring done.",
        },
      },
    });
    const profiles = parsed.setup as Record<string, unknown>;
    expect(profiles.default).toEqual([{ name: "install", run: "pnpm install" }]);
    expect(profiles.backend).toEqual({
      setup: [{ name: "install", run: "pnpm install" }],
      contract: "Run the backend test suite before declaring done.",
    });
  });

  it("accepts { setup, contract } with no contract key (setup-only object form)", () => {
    expect(() =>
      BuildSpecSchema.parse({ setup: { default: { setup: [{ name: "install", run: "pnpm install" }] } } }),
    ).not.toThrow();
  });

  it("rejects a { setup, contract } profile with an empty contract string", () => {
    expect(() =>
      BuildSpecSchema.parse({
        setup: { default: { setup: [{ name: "install", run: "pnpm install" }], contract: "" } },
      }),
    ).toThrow();
  });

  it("accepts a profile written as { setup, review } alongside contract and bare-array profiles", () => {
    const parsed = BuildSpecSchema.parse({
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        dashboard: {
          setup: [{ name: "install", run: "pnpm install" }],
          review: "Check accessibility and dark-mode theming.",
        },
      },
    });
    const profiles = parsed.setup as Record<string, unknown>;
    expect(profiles.dashboard).toEqual({
      setup: [{ name: "install", run: "pnpm install" }],
      review: "Check accessibility and dark-mode theming.",
    });
  });

  it("rejects a { setup, review } profile with an empty review string", () => {
    expect(() =>
      BuildSpecSchema.parse({
        setup: { default: { setup: [{ name: "install", run: "pnpm install" }], review: "" } },
      }),
    ).toThrow();
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

  describe("type and contract", () => {
    const contractSpec: BuildSpec = {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        backend: {
          setup: [{ name: "install", run: "pnpm install" }, { name: "test-db", run: "pnpm db:migrate:test" }],
          contract: "Run the backend test suite before declaring done.",
        },
        frontend: [{ name: "install", run: "pnpm install" }],
      },
    };

    it("no type label: type and contract are both undefined, even if default declared a contract", () => {
      const selection = selectSetupProfile(contractSpec, ["fleet:ready"]);
      expect(selection.profile).toBe("default");
      expect(selection.type).toBeUndefined();
      expect(selection.contract).toBeUndefined();
    });

    it("a matched type profile with contract: reports both type and contract", () => {
      const selection = selectSetupProfile(contractSpec, ["fleet:type:backend"]);
      expect(selection.type).toBe("backend");
      expect(selection.contract).toBe("Run the backend test suite before declaring done.");
    });

    it("a matched type profile with no contract: reports the type but leaves contract undefined", () => {
      const selection = selectSetupProfile(contractSpec, ["fleet:type:frontend"]);
      expect(selection.type).toBe("frontend");
      expect(selection.contract).toBeUndefined();
    });

    it("an unmatched type label falls back to default: neither type nor contract is set", () => {
      const selection = selectSetupProfile(contractSpec, ["fleet:type:mobile"]);
      expect(selection.type).toBeUndefined();
      expect(selection.contract).toBeUndefined();
    });

    it("list-form specs never report a type or contract", () => {
      const selection = selectSetupProfile(listSpec, []);
      expect(selection.type).toBeUndefined();
      expect(selection.contract).toBeUndefined();
    });
  });

  describe("type and review checklist", () => {
    const reviewSpec: BuildSpec = {
      setup: {
        default: [{ name: "install", run: "pnpm install" }],
        dashboard: {
          setup: [{ name: "install", run: "pnpm install" }],
          review: "Check accessibility and dark-mode theming.",
        },
        frontend: [{ name: "install", run: "pnpm install" }],
      },
    };

    it("a matched type profile with review: reports both type and review", () => {
      const selection = selectSetupProfile(reviewSpec, ["fleet:type:dashboard"]);
      expect(selection.type).toBe("dashboard");
      expect(selection.review).toBe("Check accessibility and dark-mode theming.");
    });

    it("a matched type profile with no review: reports the type but leaves review undefined", () => {
      const selection = selectSetupProfile(reviewSpec, ["fleet:type:frontend"]);
      expect(selection.type).toBe("frontend");
      expect(selection.review).toBeUndefined();
    });

    it("no type label: review is undefined even if default declared one", () => {
      const selection = selectSetupProfile(reviewSpec, ["fleet:ready"]);
      expect(selection.review).toBeUndefined();
    });
  });
});

describe("contractForType", () => {
  const contractSpec: BuildSpec = {
    setup: {
      default: [{ name: "install", run: "pnpm install" }],
      backend: {
        setup: [{ name: "install", run: "pnpm install" }],
        contract: "Run the backend test suite before declaring done.",
      },
      frontend: [{ name: "install", run: "pnpm install" }],
    },
  };

  it("returns a type's declared contract", () => {
    expect(contractForType(contractSpec, "backend")).toBe("Run the backend test suite before declaring done.");
  });

  it("is undefined for a type with no contract key", () => {
    expect(contractForType(contractSpec, "frontend")).toBeUndefined();
  });

  it("is undefined for an unknown type name", () => {
    expect(contractForType(contractSpec, "mobile")).toBeUndefined();
  });

  it("is undefined when type is undefined", () => {
    expect(contractForType(contractSpec, undefined)).toBeUndefined();
  });

  it("is undefined for list-form specs regardless of type", () => {
    const listSpec: BuildSpec = { setup: [{ name: "install", run: "pnpm install" }] };
    expect(contractForType(listSpec, "backend")).toBeUndefined();
  });
});

describe("checklistForType", () => {
  const reviewSpec: BuildSpec = {
    setup: {
      default: [{ name: "install", run: "pnpm install" }],
      dashboard: {
        setup: [{ name: "install", run: "pnpm install" }],
        review: "Check accessibility and dark-mode theming.",
      },
      frontend: [{ name: "install", run: "pnpm install" }],
    },
  };

  it("returns a type's declared review checklist", () => {
    expect(checklistForType(reviewSpec, "dashboard")).toBe("Check accessibility and dark-mode theming.");
  });

  it("is undefined for a type with no review key", () => {
    expect(checklistForType(reviewSpec, "frontend")).toBeUndefined();
  });

  it("is undefined for an unknown type name", () => {
    expect(checklistForType(reviewSpec, "mobile")).toBeUndefined();
  });

  it("is undefined when type is undefined", () => {
    expect(checklistForType(reviewSpec, undefined)).toBeUndefined();
  });

  it("is undefined for list-form specs regardless of type", () => {
    const listSpec: BuildSpec = { setup: [{ name: "install", run: "pnpm install" }] };
    expect(checklistForType(listSpec, "dashboard")).toBeUndefined();
  });
});
