import { describe, expect, it } from "vitest";
import { resolveTarget, type ResolveOptions } from "./resolve.ts";

const config = {
  path: "/w/fleet.config.json",
  config: {
    dashboardPort: 4411,
    projects: [
      { name: "alpha", githubRepo: "acme/alpha" },
      { name: "beta", githubRepo: "acme/beta" },
    ],
  },
};

const withConfig: ResolveOptions = { loadConfig: () => config };
const noConfig: ResolveOptions = { loadConfig: () => undefined };

describe("resolveTarget — repo", () => {
  it("FLEET_REPO wins outright and needs no config", () => {
    const t = resolveTarget({ FLEET_REPO: "acme/solo" }, noConfig);
    expect(t.repo).toBe("acme/solo");
    expect(t.daemonUrl).toBeUndefined();
    expect(t.project).toBeUndefined();
  });

  it("rejects a malformed FLEET_REPO", () => {
    expect(() => resolveTarget({ FLEET_REPO: "acme" }, noConfig)).toThrow(/owner\/name/);
  });

  it("looks FLEET_PROJECT up in the config", () => {
    const t = resolveTarget({ FLEET_PROJECT: "beta" }, withConfig);
    expect(t.repo).toBe("acme/beta");
    expect(t.project).toBe("beta");
  });

  it("fails clearly when FLEET_PROJECT is set but no config exists", () => {
    expect(() => resolveTarget({ FLEET_PROJECT: "beta" }, noConfig)).toThrow(/FLEET_REPO=owner\/name instead/);
  });

  it("fails clearly when FLEET_PROJECT names a project the config lacks, listing the known ones", () => {
    expect(() => resolveTarget({ FLEET_PROJECT: "gamma" }, withConfig)).toThrow(/known: alpha, beta/);
  });

  it("fails clearly with nothing set", () => {
    expect(() => resolveTarget({}, withConfig)).toThrow(/Set FLEET_REPO/);
  });

  it("passes FLEET_CONFIG through to the loader", () => {
    let seen: string | undefined;
    resolveTarget({ FLEET_PROJECT: "alpha", FLEET_CONFIG: "/x/cfg.json" }, {
      loadConfig: (explicit) => {
        seen = explicit;
        return config;
      },
    });
    expect(seen).toBe("/x/cfg.json");
  });
});

describe("resolveTarget — daemon", () => {
  it("FLEET_URL wins and is used verbatim (minus a trailing slash)", () => {
    const t = resolveTarget({ FLEET_REPO: "acme/solo", FLEET_URL: "http://box:4400/" }, withConfig);
    expect(t.daemonUrl).toBe("http://box:4400");
  });

  it("falls back to the config's dashboardPort on localhost", () => {
    const t = resolveTarget({ FLEET_PROJECT: "alpha" }, withConfig);
    expect(t.daemonUrl).toBe("http://localhost:4411");
  });

  it("with FLEET_REPO and a config, still finds the daemon and infers the project name from the repo", () => {
    const t = resolveTarget({ FLEET_REPO: "acme/beta" }, withConfig);
    expect(t.daemonUrl).toBe("http://localhost:4411");
    expect(t.project).toBe("beta");
  });

  it("leaves the daemon unset with FLEET_REPO alone, and says so", () => {
    const t = resolveTarget({ FLEET_REPO: "acme/solo" }, noConfig);
    expect(t.daemonUrl).toBeUndefined();
    expect(t.describe).toMatch(/no daemon/);
  });
});
