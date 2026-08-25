import { describe, expect, test } from "bun:test";
import { mapModel } from "../src/model.js";

const NO_MODELS = {};

describe("mapModel (B1/B2 'model' row)", () => {
  test("absent / non-string / empty / inherit -> omitted, no diagnostic", () => {
    for (const raw of [undefined, null, 42, "", "   ", "inherit"]) {
      expect(mapModel(raw, NO_MODELS, "claude.agents")).toEqual({});
    }
  });

  test("alias mapped through options.models when present", () => {
    const mapped = mapModel("sonnet", { sonnet: "anthropic/claude-sonnet-4-5" }, "claude.agents");
    expect(mapped.model).toBe("anthropic/claude-sonnet-4-5");
    expect(mapped.diagnostic).toBeUndefined();
  });

  test("alias without a user mapping -> omitted + info diagnostic naming the alias", () => {
    const result = mapModel("haiku", NO_MODELS, "claude.agents");
    expect(result.model).toBeUndefined();
    expect(result.diagnostic?.level).toBe("info");
    expect(result.diagnostic?.reason).toContain("haiku");
    expect(result.diagnostic?.reason).toMatch(/^unmapped-model-alias:/);
  });

  test("full claude-* id -> anthropic/<id>", () => {
    expect(mapModel("claude-opus-4-1", NO_MODELS, "claude.agents").model).toBe("anthropic/claude-opus-4-1");
  });

  test("an explicit user mapping wins over the built-in claude-* default", () => {
    const mapped = mapModel(
      "claude-sonnet-4-5",
      { "claude-sonnet-4-5": "github-copilot/claude-sonnet-4" },
      "claude.agents",
    );
    expect(mapped.model).toBe("github-copilot/claude-sonnet-4");
  });

  test("unrecognized string -> omitted + info diagnostic", () => {
    const result = mapModel("gpt-9", NO_MODELS, "claude.agents");
    expect(result.model).toBeUndefined();
    expect(result.diagnostic?.level).toBe("info");
    expect(result.diagnostic?.reason).toMatch(/^unmapped-model:/);
  });

  test("diagnostics carry the calling source and the model field", () => {
    const result = mapModel("opus", NO_MODELS, "copilot.agents");
    expect(result.diagnostic?.source).toBe("copilot.agents");
    expect(result.diagnostic?.field).toBe("model");
  });
});
